/**
 * `pp tui` — a control panel, not a terminal emulator.
 *
 * Two lists: the sessions on the left, the todos on the right. Enter hands the terminal over to tmux (`attach-session` / `switch-client`)
 * and comes back when you detach — no VT parsing lives here, which is the whole
 * point: tmux already knows how to draw a pane.
 *
 * Everything below `renderFrame` is pure so it can be tested without a tty.
 */
import { spawnSync } from "node:child_process";

const ESC = "\u001b[";
const REVERSE = `${ESC}7m`;
const DIM = `${ESC}2m`;
const BOLD = `${ESC}1m`;
const YELLOW = `${ESC}33m`;
const RESET = `${ESC}0m`;
const CLEAR = `${ESC}2J${ESC}H`;
const HIDE_CURSOR = `${ESC}?25l`;
const SHOW_CURSOR = `${ESC}?25h`;
const ALT_SCREEN = `${ESC}?1049h`;
const MAIN_SCREEN = `${ESC}?1049l`;
/** How the session list can be ordered (`s` cycles through these). */
const SORTS = ["config", "idle", "name", "role"];

/** Trailers keep the cursor from ever wrapping onto a new line. */
const WRAP_OFF = `${ESC}?7l`;
const WRAP_ON = `${ESC}?7h`;

const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g;

/** Drop colour codes: they take no columns, but they are not free to measure. */
export function stripAnsi(text) {
  return String(text ?? "").replace(ANSI, "");
}

/** Columns a string occupies on screen: CJK / emoji count double. */
export function displayWidth(text) {
  let width = 0;
  for (const char of stripAnsi(text)) {
    const code = char.codePointAt(0);
    if (code < 32) continue;
    width += isWide(code) ? 2 : 1;
  }
  return width;
}

function isWide(code) {
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0x303e) ||
    (code >= 0x3041 && code <= 0x33ff) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0xa000 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1f64f) ||
    (code >= 0x1f900 && code <= 0x1f9ff) ||
    (code >= 0x1f680 && code <= 0x1f6ff)
  );
}

export function truncateWidth(text, width) {
  const value = stripAnsi(text);
  if (width <= 0) return "";
  if (displayWidth(value) <= width) return value;
  let out = "";
  let used = 0;
  for (const char of value) {
    const size = displayWidth(char);
    if (used + size > Math.max(0, width - 1)) break;
    out += char;
    used += size;
  }
  return `${out}…`;
}

export function padWidth(text, width) {
  const value = String(text ?? "");
  const measured = displayWidth(value);
  if (measured <= width) return value + " ".repeat(width - measured);
  return truncateWidth(value, width);
}

/**
 * One chunk of stdin can carry several keys ("\u001b[B\u001b[B") or a burst of
 * plain characters when a paste happens. Only the keys this panel cares about
 * are returned; everything else is dropped.
 */
export function parseKeys(input) {
  const keys = [];
  const text = String(input ?? "");
  let i = 0;
  while (i < text.length) {
    const rest = text.slice(i);
    if (rest.startsWith("\u001b[A") || rest.startsWith("\u001bOA")) {
      keys.push("up");
      i += 3;
    } else if (rest.startsWith("\u001b[B") || rest.startsWith("\u001bOB")) {
      keys.push("down");
      i += 3;
    } else if (rest.startsWith("\u001b[D") || rest.startsWith("\u001bOD")) {
      // left/right move between the three lists
      keys.push("prevPanel");
      i += 3;
    } else if (rest.startsWith("\u001b[C") || rest.startsWith("\u001bOC")) {
      keys.push("nextPanel");
      i += 3;
    } else if (rest.startsWith("\u001b[5~")) {
      keys.push("pageup");
      i += 4;
    } else if (rest.startsWith("\u001b[6~")) {
      keys.push("pagedown");
      i += 4;
    } else if (rest.startsWith("\u001b")) {
      keys.push("escape");
      i += rest.startsWith("\u001b[") ? 3 : 1;
    } else if (rest.startsWith("\r") || rest.startsWith("\n")) {
      keys.push("enter");
      i += 1;
    } else if (rest.startsWith("\t")) {
      keys.push("tab");
      i += 1;
    } else if (rest[0] === "\u0015") {
      // ctrl-u / ctrl-d: the page keys a laptop does not have
      keys.push("pageup");
      i += 1;
    } else if (rest[0] === "\u0004") {
      keys.push("pagedown");
      i += 1;
    } else if (rest.startsWith("\u0003")) {
      keys.push("quit");
      i += 1;
    } else {
      const char = rest[0];
      // space pages down, b pages up: the keys every keyboard has
      if (char === " ") {
        keys.push("pagedown");
        i += 1;
        continue;
      }
      if (char === "b") {
        keys.push("pageup");
        i += 1;
        continue;
      }
      if (char === "q") keys.push("quit");
      else if (char === "j") keys.push("down");
      else if (char === "k") keys.push("up");
      else if (char === "d") keys.push("done");
      else if (char === "r") keys.push("refresh");
      else if (char === "?") keys.push("help");
      else if (char === "[") keys.push("narrower");
      else if (char === "]") keys.push("wider");
      else if (char === "g") keys.push("top");
      else if (char === "G") keys.push("bottom");
      else if (char === "s") keys.push("sort");
      else if (char === "n") keys.push("scope");
      else if (char === "D") keys.push("drift");
      else if (char === "/") keys.push("filter");
      i += 1;
    }
  }
  return keys;
}

/** Narrowest sensible sessions column, and how much the todo column needs. */
export const MIN_LEFT_WIDTH = 18;
export const RIGHT_MIN_WIDTH = 26;
export const DEFAULT_LEFT_RATIO = 0.34;
export const LEFT_STEP = 4;
export const NODE_MIN_WIDTH = 16;
export const NODE_MAX_WIDTH = 28;

export function clampLeftWidth(value, cols) {
  const width = Math.max(40, cols);
  return Math.min(Math.max(Math.round(Number(value) || 0), MIN_LEFT_WIDTH), Math.max(MIN_LEFT_WIDTH, width - RIGHT_MIN_WIDTH - 1));
}

/**
 * `--left 30` (columns) or `--left 28%` → a column count for this terminal.
 */
export function parseLeftOption(text, cols = 100) {
  const value = String(text ?? "").trim();
  if (!value) throw new Error("--left needs a width (e.g. 30 or 28%)");
  if (value.endsWith("%")) {
    const percent = Number(value.slice(0, -1));
    if (!Number.isFinite(percent) || percent <= 0 || percent >= 100) {
      throw new Error(`--left ${value} is not a percentage between 1 and 99`);
    }
    return clampLeftWidth((Math.max(40, cols) * percent) / 100, cols);
  }
  const columns = Number(value);
  if (!Number.isFinite(columns) || columns < MIN_LEFT_WIDTH) {
    throw new Error(`--left must be at least ${MIN_LEFT_WIDTH} columns (or a percentage such as 30%)`);
  }
  return clampLeftWidth(columns, cols);
}

/** Narrower than this and two columns stop paying for themselves: stack them. */
export const STACK_WIDTH = 88;
export const TODO_MIN_HEIGHT = 3;
export const TODO_MAX_HEIGHT = 9;

/**
 * The todo box grows with its content (between TODO_MIN_HEIGHT and
 * TODO_MAX_HEIGHT) when the panels are stacked; side by side it takes the column.
 */
export function todoBoxHeight(todoCount, body) {
  const wanted = Math.max(TODO_MIN_HEIGHT, Math.min((Number(todoCount) || 0) + 2, TODO_MAX_HEIGHT));
  return Math.max(3, Math.min(wanted, body - 3));
}

export function computeLayout(cols, rows, { leftWidth: wanted = 0, todoCount = 0, nodes = 0 } = {}) {
  const width = Math.max(40, cols);
  const height = Math.max(10, rows);
  const footer = 1;
  const body = height - footer;
  const mode = width < STACK_WIDTH ? "stacked" : "split";
  // no pane preview any more: the todo list gets the whole right column
  const todoHeight = (Number(todoCount) || 0) === 0 && mode === "stacked" ? 0 : body;

  if (mode === "stacked") {
    const todos = todoHeight ? Math.max(TODO_MIN_HEIGHT, Math.min(todoBoxHeight(todoCount, body), body - 4)) : 0;
    // machines on top, then sessions, then todo: a narrow terminal still gets
    // all three lists, just stacked
    const machinesHeight = Number(nodes) > 1 ? Math.min(Number(nodes) + 2, Math.max(3, Math.floor(body / 3))) : 0;
    const sessionsHeight = body - todos - machinesHeight;
    return {
      width,
      height,
      mode,
      todoHeight: todos,
      nodes: machinesHeight ? { x: 0, y: 0, w: width, h: machinesHeight } : null,
      sessions: { x: 0, y: machinesHeight, w: width, h: sessionsHeight },
      todos: { x: 0, y: machinesHeight + sessionsHeight, w: width, h: todos },
      footer: { x: 0, y: body, w: width, h: footer },
    };
  }

  // three columns: which machine, its sessions, what is waiting
  const nodeWidth = Number(nodes) > 0 ? Math.min(NODE_MAX_WIDTH, Math.max(NODE_MIN_WIDTH, Math.floor(width * 0.2))) : 0;
  // with the machines column in place the session name is the longest thing on
  // screen, so it takes a bigger share than the two-column 34%
  const ratio = nodeWidth ? 0.46 : DEFAULT_LEFT_RATIO;
  const leftWidth = clampLeftWidth(wanted || Math.floor((width - nodeWidth) * ratio), width - nodeWidth);
  const sessionsX = nodeWidth ? nodeWidth + 1 : 0;
  const rightWidth = width - sessionsX - leftWidth - 1;
  return {
    width,
    height,
    mode,
    todoHeight,
    nodes: nodeWidth ? { x: 0, y: 0, w: nodeWidth, h: body } : null,
    sessions: { x: sessionsX, y: 0, w: leftWidth, h: body },
    todos: { x: sessionsX + leftWidth + 1, y: 0, w: rightWidth, h: body },
    footer: { x: 0, y: body, w: width, h: footer },
  };
}

function boxLines(box, title, rows, { focus = false } = {}) {
  const inner = Math.max(0, box.w - 2);
  const label = truncateWidth(` ${title} `, inner);
  const head = box.w >= 4 ? `┌${label}${"─".repeat(Math.max(0, inner - displayWidth(label)))}┐` : "".padEnd(box.w, "─");
  const lines = [focus ? `${BOLD}${head}${RESET}` : head];
  for (let i = 0; i < box.h - 2; i += 1) {
    const row = padWidth(rows[i] ?? "", inner);
    lines.push(`│${row}│`);
  }
  lines.push(box.w >= 4 ? `└${"─".repeat(inner)}┘` : "".padEnd(box.w, "─"));
  return lines;
}

function listRow(item, width, selected) {
  const text = padWidth(item.label, width);
  if (!selected) {
    if (item.dim) return `${DIM}${text}${RESET}`;
    // quiet for a long time: not broken, just worth a look
    if (item.warn) return `${YELLOW}${text}${RESET}`;
    return text;
  }
  return `${REVERSE}${text}${RESET}`;
}

/**
 * "local 1 · work-01 9" — the machines the list is spread over. Empty when
 * everything lives on one machine, so a single-machine panel keeps its title.
 */
export function machineSummary(rows = []) {
  const counts = new Map();
  for (const row of rows) {
    const machine = row?.node || "local";
    counts.set(machine, (counts.get(machine) ?? 0) + 1);
  }
  if (counts.size < 2) return "";
  return [...counts.entries()].map(([machine, count]) => `${machine} ${count}`).join(" · ");
}

/**
 * Build the whole frame as `height` strings of `width` columns. Pure: the same
 * model always renders the same bytes, which is what the tests assert.
 */
export function renderFrame(state, layout) {
  const inner = (box) => Math.max(0, box.w - 2);
  const sessionRows = state.sessions
    .slice(0, Math.max(0, layout.sessions.h - 2))
    .map((item) => listRow(item, inner(layout.sessions), state.focus === "sessions" && item.selected));
  const todoRows = state.todos
    .slice(Math.max(0, state.todoOffset ?? 0), Math.max(0, state.todoOffset ?? 0) + Math.max(0, layout.todos.h - 2))
    .map((item) => listRow(item, inner(layout.todos), state.focus === "todos" && item.selected));

  const nodeRows = (state.nodes ?? [])
    .slice(0, Math.max(0, (layout.nodes?.h ?? 0) - 2))
    .map((item) => listRow(item, inner(layout.nodes), state.focus === "nodes" && item.selected));
  const nodeBox = layout.nodes
    ? boxLines(layout.nodes, `machines (${(state.nodes ?? []).length})`, nodeRows, { focus: state.focus === "nodes" })
    : [];
  // the machines column already says which machines: no "local 2 · work-01 9"
  // in the title, it only made the title too long to read
  const left = boxLines(layout.sessions, `sessions (${state.sessions.length})`, sessionRows, { focus: state.focus === "sessions" });
  const rightTop = boxLines(layout.todos, `todo (${state.todos.length})`, todoRows, { focus: state.focus === "todos" });

  const out = [];
  if (layout.mode === "stacked") {
    for (const [block, rect] of [
      [nodeBox, layout.nodes],
      [left, layout.sessions],
      [rightTop, layout.todos],
    ]) {
      if (!rect || rect.h <= 0) continue;
      for (const line of block) out.push(padWidth(line, layout.width));
    }
  } else {
    for (let row = 0; row < layout.height; row += 1) {
      if (row === layout.footer.y) {
        out.push(padWidth(state.footer ?? "", layout.width));
        continue;
      }
      const nodeLine = layout.nodes ? nodeBox[row] ?? "" : "";
      const leftLine = left[row] ?? "";
      const rightLine = rightTop[row] ?? "";
      out.push(padWidth(`${nodeLine ? `${nodeLine} ` : ""}${leftLine} ${rightLine}`, layout.width));
    }
  }
  out[layout.footer.y] = padWidth(state.footer ?? "", layout.width);
  return out.slice(0, layout.height);
}

/**
 * Paint a whole frame with absolute cursor addressing.
 *
 * This is deliberately paranoid: a control panel that paints with `\n` and
 * relies on the terminal not to wrap will scroll (and look like it is appending
 * frames) the moment one line is a column too wide — CJK previews are exactly
 * that case. Addressing every row and erasing the tail of each line means a
 * mis-measured glyph can only dirty its own row, never scroll the pane, and no
 * screen clear is issued per frame (nothing lands in a terminal scrollback).
 */
export function paintFrame(lines, { previous = null } = {}) {
  // A panel that redraws every second mostly redraws the same rows. Absolute
  // addressing means unchanged rows can simply be skipped: over ssh the
  // difference between 51 rows and 3 is the difference between a busy link and
  // an idle one.
  let out = "";
  let painted = 0;
  for (let i = 0; i < lines.length; i += 1) {
    if (previous && previous[i] === lines[i]) continue;
    // erase the row *before* writing: EL after a full-width line would eat its last cell.
    // The line goes out verbatim: stripping ANSI here would silently drop the
    // selection highlight, the bold borders and the dim footer.
    out += `${ESC}${i + 1};1H${ESC}K${lines[i]}`;
    painted += 1;
  }
  // a shorter frame than last time leaves the old tail on screen
  for (let i = lines.length; previous && i < previous.length; i += 1) {
    out += `${ESC}${i + 1};1H${ESC}K`;
  }
  return painted === 0 && out === "" ? "" : WRAP_OFF + out;
}

/** Keep a selection inside a list and the list scrolled to it. */
export function moveSelection(index, length, delta) {
  if (length <= 0) return 0;
  return Math.min(length - 1, Math.max(0, index + delta));
}

/**
 * The interactive shell. `io` is injected so tests can drive it without a tty:
 *   io.input  (readable) io.output (writable) io.isTTY io.size() {cols, rows}
 *   io.onResize(cb)  io.refresh() -> {sessions, todos}
 *   io.attach(name) -> promise settled when tmux gives the terminal back
 */
export function createTui({
  io,
  version = "",
  leftWidth = 0,
  sort = "config",
  intervalMs = 1000,
  staticMode = false,
  trace = null,
  onSlow = null,
}) {
  let state = {
    sessions: [],
    todos: [],
    focus: "sessions",
    footer: "",
    todoOffset: 0,
    sessionOffset: 0,
    sessionIndex: 0,
    todoIndex: 0,
    leftWidth: 0,
    /** 0 = let the layout decide; otherwise the todo box gets exactly this many rows */
    /** config | idle (quietest first) | name | role — see SORTS */
    sort: SORTS.includes(sort) ? sort : "config",
    /** substring the session list is narrowed to; "" = everything */
    filter: "",
    /** true while the `/` box has the keyboard */
    typing: false,
    /** what has been typed into that box so far */
    input: "",
    /** the rows currently on screen, so an unchanged row is not sent again */
    painted: null,
  };
  let running = false;
  /**
   * `running` means "the panel owns the screen"; `finished` means "the user wants out".
   * They must stay separate: handing the terminal to tmux drops `running` too, and
   * treating that as a quit used to pause stdin and leave a frozen panel behind.
   */
  let finished = false;
  let timer = null;
  /** an attach() problem is shown in the footer: printing mid-frame would tear the screen */
  let attachNote = "";
  let attachNoteUntil = 0;
  state.leftWidth = leftWidth;

  function footerText(extra = "") {
    // drift, in the footer: sessions of ours that are off, and live ones that
    // are not ours. Both are the reason someone opens this panel at 3am.
    const off = state.sessions.filter((row) => row.state === "off" || row.state === "dead" || row.state === "stopped").length;
    const unmanaged = state.sessions.filter((row) => row.unmanaged).length;
    // "busy but silent": the row looked alive because the spinner kept moving
    const stuck = state.sessions.filter((row) => row.stuck).length;
    const drift = [off ? `${off} off` : null, unmanaged ? `${unmanaged} unmanaged` : null, stuck ? `${stuck} stuck` : null]
      .filter(Boolean)
      .join(" · ");
    if (state.typing) {
      const typed = `/ ${state.input}▌`;
      return `${DIM}${padWidth(` ${typed}  (Enter filter · Esc clear · ${filteredIndices().length} match)`, io.size().cols)}${RESET}`;
    }
    const total = state.sessions.length;
    const shown = filteredIndices().length;
    const filterNote = state.filter ? `filter: ${state.filter} (${shown}/${total}) · / clear · ` : "/ find · ";
    const base = ` ↑↓ move · ←→ column · Space/b page · Enter attach · ${filterNote}d done · D start what is off · q quit `;
    // the panel stretched its own interval because the link could not keep up:
    // say so, otherwise "why is it not updating" has no answer on screen
    const slow = interval > baseIntervalMs ? `slow ${(interval / 1000).toFixed(1)}s · ` : "";
    const text = extra ? `${slow}${extra}  ${base}` : `${slow}${base}`;
    return `${drift ? `${YELLOW}${drift}${RESET}${DIM} · ` : ""}${DIM}${padWidth(text, io.size().cols)}${RESET}`;
  }

  /**
   * Display order for the session list. The selection is tracked by identity
   * (an index into state.sessions), the cursor moves in *display* positions —
   * otherwise a list that reorders itself every second (idle sort) would move
   * the cursor under the user's hands.
   */
  /** Rows that pass the substring filter (`/risk`), by index into state.sessions. */
  /**
   * The needle `/` typed, but only for the column it was typed in — searching
   * machines must not hide the sessions you went looking for.
   */
  function needleNow(panel = state.focus) {
    if (state.filterPanel && state.filterPanel !== panel) return "";
    return String((state.typing ? state.input : state.filter) ?? "").trim().toLowerCase();
  }

  /** Machine rows that match the needle: name, address, or "local". */
  function nodeOrder() {
    const needle = needleNow("nodes");
    const indices = (state.nodes ?? []).map((_, i) => i);
    if (!needle) return indices;
    return indices.filter((index) => {
      const row = state.nodes[index] ?? {};
      return `${row.name || "local"} ${row.label ?? ""}`.toLowerCase().includes(needle);
    });
  }

  /** Todo rows that match: the sentence, the session it belongs to, its kind. */
  function todoOrder() {
    const needle = needleNow("todos");
    const indices = state.todos.map((_, i) => i);
    if (!needle) return indices;
    return indices.filter((index) => {
      const row = state.todos[index] ?? {};
      return `${row.label ?? ""} ${row.session ?? row.name ?? ""} ${row.kind ?? ""}`.toLowerCase().includes(needle);
    });
  }

  function filteredIndices() {
    // while the box is open the list narrows as you type, so you see the match
    // count next to what you are typing instead of after pressing Enter
    const needle = needleNow("sessions");
    const indices = state.sessions.map((_, i) => i);
    if (!needle) return indices;
    return indices.filter((index) => {
      const row = state.sessions[index] ?? {};
      const hay = `${row.name ?? ""} ${row.role ?? ""} ${row.node ?? ""} ${row.state ?? ""}`.toLowerCase();
      return hay.includes(needle);
    });
  }

  function sessionOrder() {
    const rows = state.sessions;
    const indices = filteredIndices();
    if (state.sort === "idle") {
      // quietest first; rows with no activity at all (stopped) come last
      indices.sort((a, b) => (rows[b].idleSeconds ?? -1) - (rows[a].idleSeconds ?? -1));
    } else if (state.sort === "role") {
      // a label is the thing you group by: same role adjacent, none last
      indices.sort((a, b) => {
        const left = String(rows[a].role ?? "");
        const right = String(rows[b].role ?? "");
        if (left !== right) {
          if (!left) return 1;
          if (!right) return -1;
          return left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" });
        }
        return String(rows[a].name ?? "").localeCompare(String(rows[b].name ?? ""), undefined, {
          numeric: true,
          sensitivity: "base",
        });
      });
    } else if (state.sort === "name") {
      indices.sort((a, b) =>
        String(rows[a].name ?? "").localeCompare(String(rows[b].name ?? ""), undefined, {
          numeric: true,
          sensitivity: "base",
        }),
      );
    }
    return indices;
  }

  function sessionPos() {
    const pos = sessionOrder().indexOf(state.sessionIndex);
    return pos === -1 ? 0 : pos;
  }

  function sessionAt(pos) {
    const order = sessionOrder();
    if (!order.length) return 0;
    return order[Math.max(0, Math.min(order.length - 1, pos))];
  }

  function indexItems() {
    const order = sessionOrder();
    const sessions = order
      .map((index) => ({ ...state.sessions[index], selected: index === state.sessionIndex }))
      .slice(Math.max(0, state.sessionOffset ?? 0));
    const nodes = nodeOrder().map((index) => ({
      ...state.nodes[index],
      selected: index === (state.nodeIndex ?? 0),
    }));
    const todos = todoOrder().map((index) => ({
      ...state.todos[index],
      selected: index === state.todoIndex,
    }));
    return { ...state, machines: machineSummary(state.sessions), nodes, sessions, todos };
  }

  /** While the filter box is open every keystroke is text, not a command. */
  async function handleFilterInput(chunk) {
    const text = String(chunk ?? "");
    let changed = false;
    for (const char of text) {
      if (char === "\r" || char === "\n") {
        state.filter = state.input.trim();
        state.typing = false;
        state.input = "";
        state.sessionOffset = 0;
        const rows = filteredIndices();
        if (!rows.includes(state.sessionIndex) && rows.length) state.sessionIndex = rows[0];
        changed = true;
        break;
      }
      if (char === "\u001b") {
        // escape: forget the filter entirely — the list is never a hidden state
        state.typing = false;
        state.input = "";
        state.filter = "";
        state.filterPanel = null;
        state.sessionOffset = 0;
        changed = true;
        break;
      }
      if (char === "\u007f" || char === "\b") {
        state.input = state.input.slice(0, -1);
        changed = true;
        continue;
      }
      if (char !== "\u0003" && char >= " ") {
        state.input += char;
        changed = true;
      }
    }
    if (changed) draw();
  }

  const baseIntervalMs = Math.max(250, Number(intervalMs) || 1000);
  let interval = baseIntervalMs;
  let refreshing = false;
  let lastWriteMs = 0;
  let lastBytes = 0;

  function draw() {
    const { cols, rows } = io.size();
    const layout = computeLayout(cols, rows, {
      leftWidth: state.leftWidth,
      todoCount: state.todos.length,
      nodes: (state.nodes ?? []).length,
    });
    const model = indexItems();
    model.footer = footerText(state.note ?? "");
    // never paint more rows than the terminal actually has
    const lines = renderFrame(model, layout).slice(0, Math.max(1, rows || layout.height));
    const text = paintFrame(lines, { previous: state.painted });
    state.painted = lines;
    if (!text) return;
    const startedAt = Date.now();
    io.output.write(text);
    // How long the write took is the only honest measure of "is this link keeping
    // up" — a blocked tty write is also why keystrokes feel stuck.
    lastWriteMs = Date.now() - startedAt;
    lastBytes = text.length;
    state.note = state.note ?? "";
  }

  async function refresh(extra = "", { sticky = false } = {}) {
    const data = await io.refresh({ index: state.sessionIndex, focus: state.focus });
    // A result the user asked for ("started 2") must outlive the next 1s tick,
    // otherwise it flashes for a quarter of a second. It goes in the same slot
    // as an attach note — but a plain redraw must never overwrite that note.
    if (sticky && extra) {
      attachNote = extra;
      attachNoteUntil = Date.now() + 5000;
    }
    const kept = Date.now() < attachNoteUntil ? attachNote : "";
    const note = [extra, kept].filter(Boolean).join(" · ");
    state.sessions = data.sessions ?? [];
    state.todos = data.todos ?? [];
    state.nodes = data.nodes ?? [];
    state.sessionIndex = Math.min(state.sessionIndex, Math.max(0, state.sessions.length - 1));
    state.todoIndex = Math.min(state.todoIndex, Math.max(0, state.todos.length - 1));
    state.note = note;
    state.footer = footerText(state.note);
    draw();
  }

  /** Put the terminal back, whatever killed us: a raw-mode shell is unusable. */
  function restoreTerminal() {
    try {
      // leaving the alternate screen restores whatever was behind it; wipe that
      // too, so a client that detaches later does not land under a stale frame
      io.output.write(`${SHOW_CURSOR}${WRAP_ON}${MAIN_SCREEN}${CLEAR}\u001b[3J`);
      io.input.setRawMode?.(false);
    } catch {
      // the tty may already be gone; nothing useful to do
    }
  }

  function cleanup() {
    running = false;
    if (timer) clearInterval(timer);
    timer = null;
    restoreTerminal();
  }

  function enterScreen() {
    // Taking the screen back also means taking the keyboard back: cleanup()
    // turns raw mode off before handing the terminal to tmux, and without this
    // the panel looks alive (the timer keeps repainting) with a dead keyboard --
    // exactly the "it froze after /pp-back" report.
    io.input.setRawMode?.(true);
    io.input.resume?.();
    // clear exactly once, when taking over the screen. Repainting must not clear:
    // a terminal that keeps an alternate-screen scrollback (iTerm2 can) saves one
    // frame per ED, which is what makes the panel look like it is appending.
    io.output.write(`${ALT_SCREEN}${HIDE_CURSOR}${CLEAR}${WRAP_OFF}`);
    // the screen was just wiped: nothing on it counts as painted any more
    state.painted = null;
  }

  /** attach() ran into a problem: say it in the footer instead of on the screen. */
  function noteFromAttach(text, ms = 5000) {
    attachNote = text;
    attachNoteUntil = Date.now() + ms;
  }

  function quit() {
    cleanup();
    finished = true;
  }

  /** How many rows the focused panel can show right now. */
  function panelHeight(focus) {
    const { cols, rows } = io.size();
    const layout = computeLayout(cols, rows, {
      leftWidth: state.leftWidth,
      todoCount: state.todos.length,
      nodes: (state.nodes ?? []).length,
    });
    const box = focus === "sessions" ? layout.sessions : layout.todos;
    return Math.max(1, (box?.h ?? 3) - 2);
  }

  /** Scroll just enough that the cursor stays on screen. */
  function keepVisible() {
    const visible = panelHeight(state.focus);
    const window = state.focus === "sessions" ? "sessionOffset" : "todoOffset";
    const index = state.focus === "sessions" ? sessionPos() : state.todoIndex;
    const total = state.focus === "sessions" ? filteredIndices().length : state.todos.length;
    let offset = Math.max(0, state[window] ?? 0);
    if (index < offset) offset = index;
    else if (index >= offset + visible) offset = index - visible + 1;
    state[window] = Math.max(0, Math.min(offset, Math.max(0, total - visible)));
  }

  async function handle(key) {
    if (key === "filter") {
      state.filterPanel = state.focus;
      state.typing = true;
      state.input = state.filter ?? "";
      draw();
      return;
    }
    if (key === "escape" && state.filter) {
      // Esc undoes the narrowest thing first: the filter, then the panel
      state.filter = "";
      state.input = "";
      state.filterPanel = null;
      state.sessionOffset = 0;
      keepVisible();
      draw();
      return;
    }
    if (key === "quit" || key === "escape") {
      quit();
      return;
    }
    if (key === "sort") {
      const next = SORTS[(SORTS.indexOf(state.sort) + 1) % SORTS.length];
      state.sort = next;
      await refresh(`sorted: ${{ config: "config order", idle: "quietest first", name: "by name", role: "by role" }[next]} (s cycles)`);
      state.noteUntil = Date.now() + 5000;
      return;
    }
    if (key === "scope") {
      // which machine the list is about: local by default, so a panel on a
      // laptop does not ssh six times a second
      const label = (await io.cycleScope?.()) ?? "local";
      await refresh(`machine: ${label} (n cycles)`);
      state.noteUntil = Date.now() + 5000;
      return;
    }
    if (key === "tab" || key === "nextPanel" || key === "prevPanel") {
      const ring = ["nodes", "sessions", "todos"];
      const at = ring.indexOf(state.focus);
      const step = key === "prevPanel" ? ring.length - 1 : 1;
      state.focus = ring[(at + step) % ring.length];
      draw();
      return;
    }
    if (key === "narrower" || key === "wider") {
      const { cols } = io.size();
      const current = state.leftWidth || clampLeftWidth(Math.floor(Math.max(40, cols) * DEFAULT_LEFT_RATIO), cols);
      const next = current + (key === "wider" ? LEFT_STEP : -LEFT_STEP);
      state.leftWidth = clampLeftWidth(next, cols);
      await refresh(`sessions column: ${state.leftWidth} columns`);
      return;
    }
    if (key === "up" || key === "down") {
      const delta = key === "up" ? -1 : 1;
      if (state.focus === "nodes") state.nodeIndex = moveSelection(state.nodeIndex ?? 0, nodeOrder().length, delta);
      else if (state.focus === "sessions") state.sessionIndex = sessionAt(sessionPos() + delta);
      else state.todoIndex = moveSelection(state.todoIndex, todoOrder().length, delta);
      keepVisible();
      await refresh();
      return;
    }
    if (key === "pageup" || key === "pagedown") {
      const step = Math.max(1, panelHeight(state.focus) - 1);
      const delta = key === "pageup" ? -step : step;
      if (state.focus === "nodes") state.nodeIndex = moveSelection(state.nodeIndex ?? 0, nodeOrder().length, delta);
      else if (state.focus === "sessions") state.sessionIndex = moveSelection(state.sessionIndex, state.sessions.length, delta);
      else state.todoIndex = moveSelection(state.todoIndex, todoOrder().length, delta);
      keepVisible();
      await refresh();
      return;
    }
    if (key === "top" || key === "bottom") {
      if (state.focus === "sessions") state.sessionIndex = sessionAt(key === "top" ? 0 : Math.max(0, state.sessions.length - 1));
      else state.todoIndex = key === "top" ? 0 : Math.max(0, todoOrder().length - 1);
      keepVisible();
      await refresh();
      return;
    }
    if (key === "refresh") {
      await refresh("refreshed");
      return;
    }
    if (key === "help") {
      await refresh("↑↓/jk move · ←→/Tab switch column · Enter attach · d close todo · D start what is off · r redraw · q quit", { sticky: true });
      return;
    }
    if (key === "drift") {
      // "start what is off" without leaving the panel: the same thing pp up
      // --drift does, and it says so in the footer instead of the screen
      const started = await io.driftUp?.();
      await refresh(started ? `started ${started}` : "nothing to start — config and machine agree", { sticky: true });
      return;
    }
    if (key === "done") {
      const todoPos = todoOrder()[state.todoIndex];
      const todo = todoPos === undefined ? undefined : state.todos[todoPos];
      if (!todo) return;
      await io.closeTodo?.(todo);
      await refresh(`closed todo: ${todo.title ?? ""}`);
      return;
    }
    if (key === "enter") {
      if (state.focus === "nodes") {
        // a machine row: hand the terminal to ssh, then take it back
        cleanup();
        const picked = nodeOrder()[state.nodeIndex ?? 0];
        const said = await io.enterNode?.(picked === undefined ? "" : state.nodes[picked]?.name ?? "");
        if (!finished) {
          running = true;
          enterScreen();
          schedule();
          await refresh(said ?? "", { sticky: Boolean(said) });
        }
        return;
      }
      const todoPos = todoOrder()[state.todoIndex];
      const todo = todoPos === undefined ? undefined : state.todos[todoPos];
      // todo rows carry the session as `name` (from tuiTodoRows); read both so a row shape change cannot
      // silently hand `undefined` to attach — that used to look like "it goes in and comes straight back out"
      const session = state.focus === "todos" && todo ? { name: todo.session ?? todo.name } : state.sessions[state.sessionIndex];
      if (!session) return;
      cleanup();
      await io.attach(session.name);
      // tmux gave the terminal back: take it again and redraw
      if (!finished) {
        running = true;
        enterScreen();
        schedule();
        await refresh();
      }
    }
  }

  /**
   * One tick: refresh, measure, and back off if this terminal cannot keep up.
   *
   * Two rules, both learned from "the panel is stuck": never let a slow frame
   * queue another one behind it, and if a frame takes longer than a fraction of
   * the interval, stretch the interval instead of redrawing faster than the link
   * can carry it.
   */
  async function tick() {
    if (refreshing) return;
    // Someone is reading another pane: writing to a hidden pane only piles frames
    // up, and the day they come back `pp back` the panel looks frozen. Ask tmux
    // whether this pane is on screen and skip the frame when it is not.
    if (typeof io.visible === "function" && !io.visible()) {
      // say so in the trace: "the panel is not updating" has this answer too
      trace?.({ skipped: "pane not visible" });
      return;
    }
    refreshing = true;
    const started = Date.now();
    try {
      await refresh();
    } catch {
      // a failed refresh must not stop the clock
    } finally {
      const took = Date.now() - started;
      trace?.({ took, writeMs: lastWriteMs, bytes: lastBytes, interval });
      // Half a second for one frame is not a "slow link", it is a frame the
      // terminal cannot swallow in time — and while it is blocked, so is the
      // keyboard: the frame cannot fit, so stretch the interval instead.
      if (took > 400 && !options.staticMode) {
        if (state.sessionIndex === undefined) state.sessionIndex = 0;
        onSlow?.({ took, bytes: lastBytes });
      }
      if (took > Math.max(150, interval / 3) && interval < 10000) {
        interval = Math.min(10000, Math.round(interval * 1.5));
        schedule();
      } else if (took < interval / 8 && interval > baseIntervalMs) {
        interval = Math.max(baseIntervalMs, Math.round(interval / 1.5));
        schedule();
      }
      refreshing = false;
    }
  }

  function schedule() {
    if (timer) clearInterval(timer);
    timer = null;
    // --static: redraw only when the keyboard says so (the calm option over ssh)
    if (staticMode) return;
    timer = setInterval(() => {
      void tick();
    }, interval);
  }

  return {
    async start() {
      running = true;
      enterScreen();
      io.onResize(() => {
        // a resized terminal has different rows: repaint the whole thing
        state.painted = null;
        draw();
      });
      io.input.setRawMode?.(true);
      io.input.resume();
      io.input.setEncoding("utf8");
      io.input.on("data", (chunk) => {
        if (state.typing) {
          handleFilterInput(chunk).catch(() => {});
          return;
        }
        for (const key of parseKeys(chunk)) {
          handle(key).catch(() => {});
        }
      });
      schedule();
      await refresh();
      return new Promise((resolve) => {
        io.input.on("end", () => {
          quit();
          resolve();
        });
        const wait = setInterval(() => {
          if (finished) {
            clearInterval(wait);
            io.input.setRawMode?.(false);
            io.input.pause();
            resolve();
          }
        }, 50);
      });
    },
    // exposed for `pp tui --once` and the tests
    async renderOnce(extra = "") {
      await refresh(extra);
      return state;
    },
    noteFromAttach,
    // a signal must not leave the shell in raw mode with the cursor hidden
    restoreTerminal,
  };
}

/** Hand the terminal to tmux, then come back. */
