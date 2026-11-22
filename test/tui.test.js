import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import {
  nodesToProbe,
  reusePreview,
} from "../src/commands.js";
const ESC = "\u001b[";
const WRAP_OFF = `${ESC}?7l`;
import {
  clampLeftWidth,
  TODO_MAX_HEIGHT,
  computeLayout,
  createTui,
  parseLeftOption,
  displayWidth,
  moveSelection,
  padWidth,
  parseKeys,
  paintFrame,
  renderFrame,
  stripAnsi,
  todoBoxHeight,
  truncateWidth,
} from "../src/tui.js";

const plain = (line) => stripAnsi(line);

test("displayWidth counts CJK and ignores colour codes", () => {
  assert.equal(displayWidth("abc"), 3);
  assert.equal(displayWidth("中文"), 4);
  assert.equal(displayWidth("mixed 中文 x"), 12);
  assert.equal(displayWidth("\u001b[1mabc\u001b[0m"), 3);
  assert.equal(displayWidth(""), 0);
});

test("truncateWidth and padWidth keep a fixed column budget", () => {
  assert.equal(truncateWidth("abcdef", 4), "abc…");
  assert.equal(truncateWidth("abc", 4), "abc");
  assert.equal(padWidth("ab", 5), "ab   ");
  assert.equal(displayWidth(padWidth("中文", 5)), 5);
  assert.equal(truncateWidth("中文中文", 5), "中文…");
});

test("parseKeys understands arrows, vi keys and control keys", () => {
  assert.deepEqual(parseKeys("\u001b[A"), ["up"]);
  assert.deepEqual(parseKeys("\u001b[B\u001b[B"), ["down", "down"]);
  assert.deepEqual(parseKeys("jk"), ["down", "up"]);
  assert.deepEqual(parseKeys("\r"), ["enter"]);
  assert.deepEqual(parseKeys("\t"), ["tab"]);
  assert.deepEqual(parseKeys("\u0003"), ["quit"]);
  assert.deepEqual(parseKeys("q"), ["quit"]);
  assert.deepEqual(parseKeys("?"), ["help"]);
  assert.deepEqual(parseKeys("xy"), []);
  assert.deepEqual(parseKeys("[]"), ["narrower", "wider"]);
});

test("computeLayout splits the screen without overlaps", () => {
  const layout = computeLayout(100, 30);
  assert.equal(layout.width, 100);
  assert.equal(layout.height, 30);
  assert.equal(layout.sessions.w + 1 + layout.todos.w, 100);
  assert.equal(layout.todos.h + layout.preview.h, 29);
  assert.equal(layout.footer.y, 29);
  const tiny = computeLayout(10, 5);
  assert.equal(tiny.width, 40);
  assert.equal(tiny.height, 10);
});

test("renderFrame fills the screen exactly and shows both panels", () => {
  const layout = computeLayout(80, 20, { todoCount: 1 });
  const lines = renderFrame(
    {
      sessions: [
        { label: "1 alpha  running", selected: true },
        { label: "2 beta  off", dim: true },
      ],
      todos: [{ label: "1. alpha — ship it (2m, settled)", selected: false }],
      preview: { title: "alpha", lines: ["$ echo hi", "hi"] },
      focus: "sessions",
      footer: " q quit ",
    },
    layout,
  );
  assert.equal(lines.length, 20);
  for (const line of lines) assert.equal(displayWidth(line), 80);
  const text = lines.map(plain).join("\n");
  assert.match(text, /sessions \(2\)/);
  assert.match(text, /todo \(1\)/);
  assert.match(text, /preview: alpha/);
  assert.match(text, /\$ echo hi/);
  assert.match(text, /q quit/);
  assert.match(lines[1], /\u001b\[7m/, "selected row is reversed");
  assert.match(lines[2], /\u001b\[2m/, "dim row is dimmed");
});

test("the sessions column can be set, clamped and parsed", () => {
  assert.equal(computeLayout(100, 26).sessions.w, 34, "default is a third of the width");
  assert.equal(computeLayout(100, 26, { leftWidth: 24 }).sessions.w, 24);
  assert.equal(computeLayout(100, 26, { leftWidth: 400 }).sessions.w, 73, "never eats the todo column");
  assert.equal(clampLeftWidth(5, 100), 18, "floor");
  assert.equal(clampLeftWidth(30, 100), 30);
  assert.equal(parseLeftOption("30", 100), 30);
  assert.equal(parseLeftOption("25%", 100), 25);
  assert.equal(parseLeftOption("30%", 80), 24);
  assert.equal(parseLeftOption("34%", 80), 27);
  assert.throws(() => parseLeftOption("abc", 100), /at least 18 columns/);
  assert.throws(() => parseLeftOption("0%", 100), /not a percentage/);
  assert.throws(() => parseLeftOption("100%", 100), /not a percentage/);
  assert.equal(parseLeftOption("4%", 100), 18, "tiny percentages clamp instead of failing");
  assert.throws(() => parseLeftOption("", 100), /needs a width/);
});

test("brackets resize the sessions column", async () => {
  const { input, io, text } = fakeIo({
    sessions: [{ label: "1 alpha", name: "alpha" }],
    todos: [],
    preview: [],
  });
  const tui = createTui({ io, version: "9.9.9" });
  const done = tui.start();
  await new Promise((resolve) => setTimeout(resolve, 60));
  input.emit("data", "]");
  await new Promise((resolve) => setTimeout(resolve, 60));
  input.emit("data", "[");
  await new Promise((resolve) => setTimeout(resolve, 60));
  input.emit("data", "q");
  await done;
  assert.match(text(), /sessions column: 31 columns/, "grows by four");
  assert.match(text(), /sessions column: 27 columns/, "and shrinks back");
});

test("renderFrame scrolls the todo list with todoOffset", () => {
  const layout = computeLayout(80, 24, { todoCount: 20 });
  const todos = Array.from({ length: 20 }, (_, index) => ({ label: `todo-${index}` }));
  const lines = renderFrame(
    { sessions: [], todos, preview: { title: "—", lines: [] }, focus: "todos", footer: "", todoOffset: 5 },
    layout,
  );
  const text = lines.map(plain).join("\n");
  assert.match(text, /todo-5/);
  assert.doesNotMatch(text, /todo-0 /);
});

test("PageDown scrolls the session list instead of running off the screen", async () => {
  const sessions = Array.from({ length: 40 }, (_, index) => ({ label: `row-${index}`, name: `s${index}` }));
  const { input, io, lastFrame } = fakeIo({ sessions, todos: [], preview: [] });
  const tui = createTui({ io, version: "9.9.9" });
  const done = tui.start();
  await new Promise((resolve) => setTimeout(resolve, 60));
  for (let i = 0; i < 8; i += 1) input.emit("data", "\u001b[6~");
  await new Promise((resolve) => setTimeout(resolve, 120));
  const last = lastFrame();
  input.emit("data", "q");
  await done;
  assert.match(last, /row-[23][0-9]/, "the cursor went deep into the list and the frame followed it");
  assert.doesNotMatch(last, /row-0 /, "the top of the list scrolled out of view");
});

test("f pauses the preview and f again resumes it", async () => {
  let calls = 0;
  const { input, io, lastFrame } = fakeIo({ sessions: [{ label: "1 alpha", name: "alpha" }], todos: [], preview: [] });
  io.refresh = async () => {
    calls += 1;
    return {
      sessions: [{ label: "1 alpha", name: "alpha" }],
      todos: [],
      preview: { title: "alpha", lines: [`frame-${calls}`] },
    };
  };
  const shown = () => (lastFrame().match(/frame-(\d+)/) ?? [])[1];
  const tui = createTui({ io, version: "9.9.9" });
  const done = tui.start();
  await new Promise((resolve) => setTimeout(resolve, 60));
  input.emit("data", "f");
  await new Promise((resolve) => setTimeout(resolve, 60));
  const frozen = shown();
  assert.ok(frozen, "the preview is on screen");
  await new Promise((resolve) => setTimeout(resolve, 1300));
  assert.equal(shown(), frozen, "the preview kept the frame it was showing");
  assert.match(lastFrame(), /PAUSED/);
  input.emit("data", "f");
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.notEqual(shown(), frozen, "following again picks up the live pane");
  input.emit("data", "q");
  await done;
});

test("- and + give the todo box an exact height", () => {
  const auto = computeLayout(120, 30, { todoCount: 2 });
  const tall = computeLayout(120, 30, { todoCount: 2, todoRows: 9 });
  assert.equal(tall.todos.h, 9);
  assert.equal(tall.preview.h, auto.preview.h - (9 - auto.todos.h), "the preview lends the rows");
  const huge = computeLayout(120, 30, { todoCount: 2, todoRows: 999 });
  assert.ok(huge.preview.h >= 3, "the preview always keeps three rows");
});

test("moveSelection clamps to the list", () => {
  assert.equal(moveSelection(0, 3, -1), 0);
  assert.equal(moveSelection(2, 3, 1), 2);
  assert.equal(moveSelection(1, 3, 1), 2);
  assert.equal(moveSelection(0, 0, 1), 0);
});

/**
 * With delta painting the visible screen has to be reassembled from the moves
 * the panel emits — the last write is a patch, not a frame.
 */
function screenOf() {
  let rows = [];
  const apply = (chunk) => {
    let row = 0;
    let index = 0;
    let pending = "";
    const commit = () => {
      if (!pending) return;
      rows[row] = (rows[row] ?? "") + pending;
      pending = "";
    };
    while (index < chunk.length) {
      const at = chunk.indexOf("\u001b[", index);
      if (at < 0) {
        pending += chunk.slice(index);
        break;
      }
      pending += chunk.slice(index, at);
      const match = /^\u001b\[([0-9;?]*)([A-Za-z])/.exec(chunk.slice(at));
      if (!match) {
        index = at + 2;
        continue;
      }
      const [full, numbers, letter] = match;
      index = at + full.length;
      if (letter === "H") {
        commit();
        row = Math.max(0, Number(numbers.split(";")[0] || 1) - 1);
      } else if (letter === "K") {
        commit();
        rows[row] = "";
      } else if (letter === "J") {
        commit();
        rows = [];
        row = 0;
      }
    }
    commit();
  };
  const frame = () => {
    const copy = [...rows];
    while (copy.length && copy[copy.length - 1] === "") copy.pop();
    return stripAnsi(copy.join("\n"));
  };
  return { apply, frame };
}

function fakeIo({ sessions, todos, preview }) {
  const input = new EventEmitter();
  input.setRawMode = () => {};
  input.resume = () => {};
  input.pause = () => {};
  input.setEncoding = () => {};
  let buffer = "";
  const screen = screenOf();
  const output = {
    write(chunk) {
      buffer += chunk;
      screen.apply(chunk);
      return true;
    },
  };
  const lastFrame = () => screen.frame();
  return {
    input,
    output,
    text: () => stripAnsi(buffer),
    lastFrame,
    raw: () => buffer,
    io: {
      input,
      output,
      isTTY: true,
      size: () => ({ cols: 80, rows: 20 }),
      onResize: () => {},
      refresh: async ({ index = 0 } = {}) => ({
        sessions: sessions.map((item, position) => ({ ...item, selected: position === index })),
        todos,
        preview: { title: sessions[index]?.name ?? "—", lines: preview },
      }),
      closeTodo: async () => {},
      attach: async () => {},
    },
  };
}

test("createTui draws, moves the selection and quits on q", async () => {
  const { input, io, text, raw } = fakeIo({
    sessions: [{ label: "1 alpha", name: "alpha" }, { label: "2 beta", name: "beta" }],
    todos: [{ label: "1. alpha — ship it" }],
    preview: ["pane line"],
  });
  const tui = createTui({ io, version: "9.9.9" });
  const done = tui.start();
  await new Promise((resolve) => setTimeout(resolve, 60));
  input.emit("data", "\u001b[B");
  await new Promise((resolve) => setTimeout(resolve, 60));
  input.emit("data", "q");
  await done;

  const drawn = text();
  assert.match(drawn, /sessions \(2\)/);
  assert.match(drawn, /preview: beta/, "preview follows the selection");
  assert.match(drawn, /pane line/);
  assert.match(raw(), /\u001b\[\?1049h/, "enters the alternate screen");
  assert.match(raw(), /\u001b\[\?1049l/, "leaves the alternate screen on quit");
});

test("createTui hands the terminal to tmux on Enter", async () => {
  const calls = [];
  const { input, io } = fakeIo({
    sessions: [{ label: "1 alpha", name: "alpha" }],
    todos: [],
    preview: [],
  });
  io.attach = async (name) => calls.push(name);
  const tui = createTui({ io, version: "9.9.9" });
  const done = tui.start();
  await new Promise((resolve) => setTimeout(resolve, 60));
  input.emit("data", "\r");
  await new Promise((resolve) => setTimeout(resolve, 120));
  input.emit("data", "q");
  await done;
  assert.deepEqual(calls, ["alpha"]);
});

test("Enter does not end the session — the panel still takes keys when tmux gives the terminal back", async () => {
  const calls = [];
  const { input, io, lastFrame } = fakeIo({
    sessions: [{ label: "1 alpha", name: "alpha" }, { label: "2 beta", name: "beta" }],
    todos: [],
    preview: [],
  });
  io.attach = async (name) => {
    // a real attach blocks for a while: tmux drives the terminal until it hands it back
    await new Promise((resolve) => setTimeout(resolve, 140));
    calls.push(name);
  };
  const tui = createTui({ io });
  let finished = false;
  const done = tui.start().then(() => {
    finished = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 60));
  input.emit("data", "\r");
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(finished, false, "handing the terminal to tmux must not be mistaken for a quit");
  input.emit("data", "\u001b[B");
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.match(lastFrame(), /preview: beta/, "keys are still handled after the attach returns");
  input.emit("data", "q");
  await done;
  assert.deepEqual(calls, ["alpha"]);
});

test("a note from a failed attach stays in the footer across refreshes", async () => {
  const { input, io, lastFrame } = fakeIo({
    sessions: [{ label: "1 alpha", name: "alpha" }],
    todos: [],
    preview: [],
  });
  const tui = createTui({ io });
  const done = tui.start();
  await new Promise((resolve) => setTimeout(resolve, 60));
  tui.noteFromAttach("alpha is not running — start it with: pp up alpha", 5000);
  input.emit("data", "r");
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.match(lastFrame(), /alpha is not running/);
  input.emit("data", "r");
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.match(lastFrame(), /alpha is not running/, "the reason survives the next tick instead of flashing away");
  input.emit("data", "q");
  await done;
});

test("D starts what is off and says so past the next tick", async () => {
  const { input, io, lastFrame } = fakeIo({
    sessions: [{ label: "1 alpha", name: "alpha" }],
    todos: [],
    preview: [],
  });
  let calls = 0;
  io.driftUp = async () => {
    calls++;
    return 2;
  };
  const tui = createTui({ io });
  const done = tui.start();
  await new Promise((resolve) => setTimeout(resolve, 60));
  input.emit("data", "D");
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(calls, 1, "D runs the same repair pp up --drift does");
  assert.match(lastFrame(), /started 2/);
  // a plain redraw must not wipe a result the user asked for
  input.emit("data", "r");
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.match(lastFrame(), /started 2/, "the result survives the next frame instead of flashing");
  input.emit("data", "q");
  await done;
});

test("D says nothing happened when the config already matches", async () => {
  const { input, io, lastFrame } = fakeIo({ sessions: [], todos: [], preview: [] });
  io.driftUp = async () => 0;
  const tui = createTui({ io });
  const done = tui.start();
  await new Promise((resolve) => setTimeout(resolve, 60));
  input.emit("data", "D");
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.match(lastFrame(), /nothing to start/);
  input.emit("data", "q");
  await done;
});

test("Enter on a todo attaches to the todo's session, not to undefined", async () => {
  const calls = [];
  const { input, io } = fakeIo({
    sessions: [{ label: "1 alpha", name: "alpha" }],
    // the shape tuiTodoRows produces: the session lives in `name`
    todos: [{ name: "beta", ref: "abc123", label: "1. beta — ship it (just now, manual)" }],
    preview: [],
  });
  io.attach = async (name) => calls.push(name);
  const tui = createTui({ io });
  const done = tui.start();
  await new Promise((resolve) => setTimeout(resolve, 60));
  input.emit("data", "\t"); // focus the todo panel
  await new Promise((resolve) => setTimeout(resolve, 60));
  input.emit("data", "\r");
  await new Promise((resolve) => setTimeout(resolve, 60));
  input.emit("data", "q");
  await done;
  assert.deepEqual(calls, ["beta"]);
});

test("paintFrame addresses every row so a wide line can never scroll the pane", () => {
  const lines = ["a", "b".repeat(3), "c"];
  const out = paintFrame(lines, 10);
  assert.match(out, /\u001b\[\?7l/, "autowrap is off while the panel owns the screen");
  for (let row = 1; row <= 3; row += 1) {
    assert.ok(out.includes(`\u001b[${row};1H`), `row ${row} is positioned absolutely`);
  }
  assert.ok(!out.includes("\u001b[0J"), "no cursor moves past the last row (that would erase it)");
  assert.ok(!out.includes("\n"), "frames are not painted with newlines");
  assert.ok(!out.includes("\u001b[2J"), "frames are never cleared wholesale (that fills a scrollback)");
  assert.ok(!out.includes("\u001b[H"), "no home-cursor clear either");
});

test("paintFrame keeps colours and attributes", () => {
  const out = paintFrame(["\u001b[7mselected\u001b[0m", "\u001b[1mbold\u001b[0m\u001b[2mdim\u001b[0m"]);
  assert.ok(out.includes("\u001b[7m"), "reverse video (the selection bar) survives");
  assert.ok(out.includes("\u001b[1m"), "bold survives");
  assert.ok(out.includes("\u001b[2m"), "dim survives");
});

test("a CJK preview never produces a line wider than the screen", () => {
  const layout = computeLayout(60, 12);
  const chinese = "任务 8a 落地（当前任务，已完成待复核）b172 (T2) 37.7K·544 553 msgs age=5 old";
  const lines = renderFrame(
    {
      sessions: [{ label: "1 risk-01  running", selected: true }],
      todos: [{ label: `1. mano-dev-01 — ${chinese}` }],
      preview: { title: "risk-01", lines: [chinese, chinese + chinese] },
      focus: "sessions",
      footer: " ↑↓ move · q quit ",
    },
    layout,
  );
  assert.equal(lines.length, layout.height);
  for (const line of lines) {
    assert.ok(displayWidth(line) <= layout.width, `line overflows: ${JSON.stringify(line)}`);
    assert.ok(!line.includes("\n"));
  }
});

test("the todo box grows with its content, the preview takes the rest", () => {
  assert.equal(todoBoxHeight(0, 30), 3, "empty list: header + one row + border");
  assert.equal(todoBoxHeight(1, 30), 3);
  assert.equal(todoBoxHeight(3, 30), 5, "three items and two borders");
  assert.equal(todoBoxHeight(50, 30), TODO_MAX_HEIGHT, "capped once it stops being useful");
  const tall = computeLayout(120, 40, { todoCount: 0 });
  const busy = computeLayout(120, 40, { todoCount: 6 });
  assert.ok(busy.preview.h < tall.preview.h, "a longer list costs the preview rows");
  assert.equal(tall.todos.h + tall.preview.h, tall.sessions.h, "the right column still adds up");
});

test("a narrow terminal stacks the panels instead of squeezing two columns", () => {
  const layout = computeLayout(70, 26, { todoCount: 2 });
  assert.equal(layout.mode, "stacked");
  assert.equal(layout.sessions.w, layout.width, "panels are full width");
  assert.equal(layout.todos.y, layout.sessions.h, "todo sits under sessions");
  assert.equal(layout.preview.y, layout.sessions.h + layout.todos.h);
  assert.equal(layout.sessions.h + layout.todos.h + layout.preview.h, layout.height - 1);

  const lines = renderFrame(
    { sessions: [], todos: [], preview: { title: "x", lines: [] }, footer: "f", focus: "sessions" },
    layout,
  );
  assert.equal(lines.length, layout.height);
  for (const line of lines) assert.equal(displayWidth(line), layout.width);
});

test("an empty todo list is hidden entirely on a narrow terminal", () => {
  const layout = computeLayout(70, 26, { todoCount: 0 });
  assert.equal(layout.todos.h, 0, "no rows wasted on an empty list");
  assert.ok(layout.preview.h > computeLayout(70, 26, { todoCount: 3 }).preview.h);
  const lines = renderFrame(
    { sessions: [], todos: [], preview: { title: "x", lines: [] }, footer: "f", focus: "sessions" },
    layout,
  );
  assert.ok(!lines.some((line) => line.includes(" todo (")), "no empty todo box");
});

test("a session that has been quiet for a while is marked, not hidden", () => {
  const layout = computeLayout(120, 20, { todoCount: 0 });
  const lines = renderFrame(
    {
      sessions: [
        { label: "1 busy running 2m", name: "busy" },
        { label: "2 quiet running 4h !", name: "quiet", warn: true },
      ],
      todos: [],
      preview: { title: "—", lines: [] },
      focus: "sessions",
      footer: "",
      sessionOffset: 0,
      todoOffset: 0,
    },
    layout,
  );
  assert.match(lines[2], /\u001b\[33m/, "the quiet one is amber");
  assert.doesNotMatch(lines[1], /\u001b\[33m/, "the busy one is not");
});

test("PP_STALE_MINUTES decides what counts as quiet", async () => {
  const { staleSeconds } = await import("../src/commands.js");
  assert.equal(staleSeconds({}), 30 * 60);
  assert.equal(staleSeconds({ PP_STALE_MINUTES: "5" }), 5 * 60);
  assert.equal(staleSeconds({ PP_STALE_MINUTES: "0" }), 30 * 60, "zero falls back to the default");
  assert.equal(staleSeconds({ PP_STALE_MINUTES: "soon" }), 30 * 60);
});

test("s cycles the session order and keeps the cursor on the same session", async () => {
  const rows = [
    { name: "b", label: "2 b running 1s", idleSeconds: 1 },
    { name: "a", label: "1 a running 9m", idleSeconds: 540 },
    { name: "c", label: "3 c off", idleSeconds: null },
  ];
  const input = new EventEmitter();
  input.setRawMode = () => {};
  input.resume = () => {};
  input.pause = () => {};
  input.setEncoding = () => {};
  let buffer = "";
  const io = {
    input,
    output: {
      write(chunk) {
        buffer += chunk;
        screen.apply(chunk);
        return true;
      },
    },
    isTTY: true,
    size: () => ({ cols: 120, rows: 24 }),
    onResize: () => {},
    refresh: async () => ({ sessions: rows, todos: [], preview: { title: "—", lines: [] } }),
    closeTodo: async () => {},
    attach: async () => {},
  };
  const screen = screenOf();
  const frame = () => screen.frame();
  const order = () =>
    ["1 a", "2 b", "3 c"]
      .map((name) => ({ name, at: frame().indexOf(name) }))
      .filter((hit) => hit.at >= 0)
      .sort((a, b) => a.at - b.at)
      .map((hit) => hit.name)
      .join(" ");
  const settle = () => new Promise((resolve) => setTimeout(resolve, 60));

  const tui = createTui({ io });
  const done = tui.start();
  await settle();
  assert.equal(order(), "2 b 1 a 3 c", "config order first");

  input.emit("data", "s");
  await settle();
  assert.equal(order(), "1 a 2 b 3 c", "idle order puts the quiet one first");
  assert.match(frame(), /quietest first/);

  input.emit("data", "s");
  await settle();
  assert.match(frame(), /by name/);

  // a fourth档: by role (no roles in this fixture, so name order stands in)
  input.emit("data", "s");
  await settle();
  assert.match(frame(), /by role/);
  assert.equal(order(), "1 a 2 b 3 c", "by role falls back to name when nothing is labelled");

  input.emit("data", "s");
  await settle();
  assert.equal(order(), "2 b 1 a 3 c", "and back round to config order");

  input.emit("data", "q");
  await done;
});

test("the / box narrows the session list to a substring, and Esc forgets it", async () => {
  const { input, io, lastFrame } = fakeIo({
    sessions: [
      { label: "1 risk-01  running", name: "risk-01", state: "running" },
      { label: "2 risk-02  running", name: "risk-02", state: "running" },
      { label: "3 mango-release-01  running", name: "mango-release-01", state: "running" },
    ],
    todos: [],
    preview: ["x"],
  });
  const tui = createTui({ io });
  const done = tui.start();
  await new Promise((resolve) => setTimeout(resolve, 60));
  input.emit("data", "/");
  input.emit("data", "risk");
  assert.match(lastFrame(), /Enter filter · Esc clear · 2 match/, "the box counts what it matches");
  input.emit("data", "\r");
  await new Promise((resolve) => setTimeout(resolve, 30));
  const narrowed = lastFrame();
  assert.match(narrowed, /risk-01/);
  assert.match(narrowed, /risk-02/);
  assert.doesNotMatch(narrowed, /mango-release-01/, "the filtered-out row is gone, not dimmed");
  assert.match(narrowed, /filter: risk \(2\/3\)/);
  input.emit("data", "\u001b");
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.match(lastFrame(), /mango-release-01/, "Esc puts the whole list back");
  input.emit("data", "q");
  await done;
});

test("the panel only asks machines that carry a session", () => {
  // six registered machines and no sessions on them is the normal case here:
  // probing all of them every frame is ~2s of ssh, and the frame timer is 1s
  assert.deepEqual(
    nodesToProbe({
      nodes: [{ name: "edge240" }, { name: "t114" }, { name: "p201" }],
      sessions: [{ name: "api", node: null }, { name: "web", node: "t114" }],
    }),
    ["t114"],
  );
  assert.deepEqual(nodesToProbe({ nodes: [{ name: "a" }], sessions: [{ name: "x" }] }), [], "nothing remote: nothing to ask");
  assert.deepEqual(nodesToProbe(null), [], "no config, no machines");
});

test("an unchanged row is not sent again, and a wiped screen is", async () => {
  const frame = ["aaa", "bbb"];
  assert.equal(paintFrame(frame), `${WRAP_OFF}${ESC}1;1H${ESC}Kaaa${ESC}2;1H${ESC}Kbbb`, "first frame paints everything");
  assert.equal(paintFrame(frame, { previous: frame }), "", "same rows: nothing to send");
  const painted = paintFrame(["aaa", "ccc"], { previous: frame });
  assert.ok(painted.includes("ccc"), "changed row is sent");
  assert.ok(!painted.includes("aaa"), "unchanged row is not");
  const shorter = paintFrame(["aaa"], { previous: frame });
  assert.ok(shorter.includes(`${ESC}2;1H${ESC}K`), "a shorter frame clears the row it no longer uses");
});

test("the preview is reused while the pane has not printed anything", () => {
  const cache = { name: "api", activity: "1700000000", height: 20, lines: ["a"] };
  assert.equal(reusePreview(cache, { name: "api", activity: "1700000000", height: 20 }), true, "same pane, same stamp, same box");
  assert.equal(reusePreview(cache, { name: "api", activity: "1700000001", height: 20 }), false, "the pane printed something: capture again");
  assert.equal(reusePreview(cache, { name: "web", activity: "1700000000", height: 20 }), false, "different session");
  assert.equal(reusePreview(cache, { name: "api", activity: "1700000000", height: 30 }), false, "the box changed height");
  assert.equal(reusePreview({ name: "api", activity: "1", height: 20, lines: null }, { name: "api", activity: "1", height: 20 }), false, "nothing captured yet");
  assert.equal(reusePreview(null, { name: "api", activity: "1", height: 20 }), false, "no cache");
});

test("a session that is busy but silent is marked stuck, not healthy", async () => {
  const { tuiSessionRows } = await import("../src/commands.js");
  const config = { sessions: [{ name: "api", tmuxName: "api", node: null, role: null }] };
  const live = new Map([["api", { activity: Math.floor(Date.now() / 1000), attached: false, panes: [{ dead: false }] }]]);
  const free = tuiSessionRows(config, live, { stuck: new Set() })[0];
  assert.equal(free.stuck, false);
  assert.equal(free.warn, false, "fresh activity and no stall: nothing to flag");
  const stuck = tuiSessionRows(config, live, { stuck: new Set(["api"]) })[0];
  assert.equal(stuck.stuck, true);
  assert.equal(stuck.warn, true, "the same yellow ! as a quiet session");
  assert.match(stuck.label, / !/);
});
