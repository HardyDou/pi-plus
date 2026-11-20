/**
 * `pp tui` — a control panel, not a terminal emulator.
 *
 * Two lists (sessions, todos) and a read-only preview of the selected session's
 * pane. Enter hands the terminal over to tmux (`attach-session` / `switch-client`)
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
const RESET = `${ESC}0m`;
const CLEAR = `${ESC}2J${ESC}H`;
const HIDE_CURSOR = `${ESC}?25l`;
const SHOW_CURSOR = `${ESC}?25h`;
const ALT_SCREEN = `${ESC}?1049h`;
const MAIN_SCREEN = `${ESC}?1049l`;
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
    } else if (rest.startsWith("\u0003")) {
      keys.push("quit");
      i += 1;
    } else {
      const char = rest[0];
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

export function computeLayout(cols, rows, { leftWidth: wanted = 0 } = {}) {
  const width = Math.max(40, cols);
  const height = Math.max(10, rows);
  const footer = 1;
  const body = height - footer;
  const leftWidth = clampLeftWidth(wanted || Math.floor(width * DEFAULT_LEFT_RATIO), width);
  const rightWidth = width - leftWidth - 1;
  const todoHeight = Math.max(4, Math.ceil(body * 0.45));
  const previewHeight = body - todoHeight;
  return {
    width,
    height,
    sessions: { x: 0, y: 0, w: leftWidth, h: body },
    todos: { x: leftWidth + 1, y: 0, w: rightWidth, h: todoHeight },
    preview: { x: leftWidth + 1, y: todoHeight, w: rightWidth, h: previewHeight },
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
  if (!selected) return item.dim ? `${DIM}${text}${RESET}` : text;
  return `${REVERSE}${text}${RESET}`;
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

  const previewTitle = state.preview?.title ? `preview: ${state.preview.title}` : "preview";
  const previewRows = (state.preview?.lines ?? [])
    .slice(0, Math.max(0, layout.preview.h - 2))
    .map((line) => padWidth(truncateWidth(line, inner(layout.preview)), inner(layout.preview)));

  const left = boxLines(layout.sessions, `sessions (${state.sessions.length})`, sessionRows, { focus: state.focus === "sessions" });
  const rightTop = boxLines(layout.todos, `todo (${state.todos.length})`, todoRows, { focus: state.focus === "todos" });
  const rightBottom = boxLines(layout.preview, previewTitle, previewRows);

  const out = [];
  for (let row = 0; row < layout.height; row += 1) {
    if (row === layout.footer.y) {
      out.push(padWidth(state.footer ?? "", layout.width));
      continue;
    }
    const leftLine = left[row] ?? "";
    const rightLine = row < layout.todos.h ? (rightTop[row] ?? "") : (rightBottom[row - layout.todos.h] ?? "");
    out.push(padWidth(`${leftLine} ${rightLine}`, layout.width));
  }
  return out;
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
export function paintFrame(lines) {
  let out = WRAP_OFF;
  for (let i = 0; i < lines.length; i += 1) {
    // erase the row *before* writing: EL after a full-width line would eat its last cell.
    // The line goes out verbatim: stripping ANSI here would silently drop the
    // selection highlight, the bold borders and the dim footer.
    out += `${ESC}${i + 1};1H${ESC}K${lines[i]}`;
  }
  return out;
}

/** Keep a selection inside a list and the list scrolled to it. */
export function moveSelection(index, length, delta) {
  if (length <= 0) return 0;
  return Math.min(length - 1, Math.max(0, index + delta));
}

/**
 * The interactive shell. `io` is injected so tests can drive it without a tty:
 *   io.input  (readable) io.output (writable) io.isTTY io.size() {cols, rows}
 *   io.onResize(cb)  io.refresh() -> {sessions, todos, preview}
 *   io.attach(name) -> promise settled when tmux gives the terminal back
 */
export function createTui({ io, version = "", leftWidth = 0 }) {
  let state = { sessions: [], todos: [], preview: { title: "—", lines: [] }, focus: "sessions", footer: "", todoOffset: 0, sessionIndex: 0, todoIndex: 0, leftWidth: 0 };
  let running = false;
  let timer = null;
  /** an attach() problem is shown in the footer: printing mid-frame would tear the screen */
  let attachNote = "";
  state.leftWidth = leftWidth;

  function footerText(extra = "") {
    const base = " ↑↓ move · Tab panel · Enter attach · d done · [ ] width · r refresh · q quit ";
    const text = extra ? `${extra}  ${base}` : base;
    return `${DIM}${padWidth(text, io.size().cols)}${RESET}`;
  }

  function indexItems() {
    const sessions = state.sessions.map((item, index) => ({ ...item, selected: index === state.sessionIndex }));
    const visible = state.todos.slice(state.todoOffset, state.todoOffset + 200);
    const todos = visible.map((item, index) => ({ ...item, selected: state.todoOffset + index === state.todoIndex }));
    return { ...state, sessions, todos };
  }

  function draw() {
    const { cols, rows } = io.size();
    const layout = computeLayout(cols, rows, { leftWidth: state.leftWidth });
    const model = indexItems();
    model.footer = footerText(state.note ?? "");
    // never paint more rows than the terminal actually has
    const lines = renderFrame(model, layout).slice(0, Math.max(1, rows || layout.height));
    io.output.write(paintFrame(lines));
  }

  async function refresh(extra = "") {
    const data = await io.refresh({ index: state.sessionIndex, focus: state.focus });
    const note = [extra, attachNote].filter(Boolean).join(" · ");
    attachNote = "";
    state.sessions = data.sessions ?? [];
    state.todos = data.todos ?? [];
    state.preview = data.preview ?? { title: "—", lines: [] };
    state.sessionIndex = Math.min(state.sessionIndex, Math.max(0, state.sessions.length - 1));
    state.todoIndex = Math.min(state.todoIndex, Math.max(0, state.todos.length - 1));
    state.note = note;
    state.footer = footerText(state.note);
    draw();
  }

  function cleanup() {
    running = false;
    if (timer) clearInterval(timer);
    timer = null;
    io.output.write(`${SHOW_CURSOR}${WRAP_ON}${MAIN_SCREEN}`);
  }

  function enterScreen() {
    // clear exactly once, when taking over the screen. Repainting must not clear:
    // a terminal that keeps an alternate-screen scrollback (iTerm2 can) saves one
    // frame per ED, which is what makes the panel look like it is appending.
    io.output.write(`${ALT_SCREEN}${HIDE_CURSOR}${CLEAR}${WRAP_OFF}`);
  }

  /** attach() ran into a problem: say it in the footer instead of on the screen. */
  function noteFromAttach(text) {
    attachNote = text;
  }

  async function handle(key) {
    if (key === "quit" || key === "escape") {
      cleanup();
      return;
    }
    if (key === "tab") {
      state.focus = state.focus === "sessions" ? "todos" : "sessions";
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
      if (state.focus === "sessions") state.sessionIndex = moveSelection(state.sessionIndex, state.sessions.length, delta);
      else state.todoIndex = moveSelection(state.todoIndex, state.todos.length, delta);
      await refresh();
      return;
    }
    if (key === "top" || key === "bottom") {
      if (state.focus === "sessions") state.sessionIndex = key === "top" ? 0 : Math.max(0, state.sessions.length - 1);
      else state.todoIndex = key === "top" ? 0 : Math.max(0, state.todos.length - 1);
      await refresh();
      return;
    }
    if (key === "refresh") {
      await refresh("refreshed");
      return;
    }
    if (key === "help") {
      await refresh("↑↓/jk move · Tab switch panel · Enter attach · d close todo · r redraw · q quit");
      return;
    }
    if (key === "done") {
      const todo = state.todos[state.todoIndex];
      if (!todo) return;
      await io.closeTodo?.(todo);
      await refresh(`closed todo: ${todo.title ?? ""}`);
      return;
    }
    if (key === "enter") {
      const todo = state.todos[state.todoIndex];
      const session = state.focus === "todos" && todo ? { name: todo.session } : state.sessions[state.sessionIndex];
      if (!session) return;
      cleanup();
      await io.attach(session.name);
      // tmux gave the terminal back: take it again and redraw
      if (!running) {
        running = true;
        enterScreen();
        timer = setInterval(() => {
          refresh().catch(() => {});
        }, 1000);
        await refresh();
      }
    }
  }

  return {
    async start() {
      running = true;
      enterScreen();
      io.onResize(() => draw());
      io.input.setRawMode?.(true);
      io.input.resume();
      io.input.setEncoding("utf8");
      io.input.on("data", (chunk) => {
        for (const key of parseKeys(chunk)) {
          handle(key).catch(() => {});
        }
      });
      timer = setInterval(() => {
        refresh().catch(() => {});
      }, 1000);
      await refresh();
      return new Promise((resolve) => {
        io.input.on("end", () => {
          cleanup();
          resolve();
        });
        const wait = setInterval(() => {
          if (!running) {
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
  };
}

/** Hand the terminal to tmux, then come back. */
export function attachInTerminal(tmuxArgs, { spawn = spawnSync } = {}) {
  const result = spawn("tmux", tmuxArgs, { stdio: "inherit" });
  return result?.status ?? 0;
}
