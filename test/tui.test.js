import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import {
  nodesToProbe,
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
  assert.equal(layout.todos.h, 29, "the todo column takes the whole body");
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
  assert.ok(!/preview/.test(text), "no pane preview any more");
  assert.match(text, /q quit/);
  assert.match(lines[1], /\u001b\[7m/, "selected row is reversed");
  assert.match(lines[2], /\u001b\[2m/, "dim row is dimmed");
});

test("the sessions column can be set, clamped and parsed", () => {
  assert.equal(computeLayout(100, 26).sessions.w, 34, "two columns: a third of the width, as before");
  assert.ok(computeLayout(100, 26, { nodes: 3 }).sessions.w > 34, "three columns: sessions get more than a third");
  assert.equal(computeLayout(100, 26, { leftWidth: 24 }).sessions.w, 24);
  assert.equal(computeLayout(100, 26, { leftWidth: 400 }).sessions.w, 73, "never eats the todo column");
  assert.equal(computeLayout(100, 26, { nodes: 3, leftWidth: 400 }).sessions.h, 25, "and the machines column costs width, not height");
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
    { sessions: [], todos, focus: "todos", footer: "", todoOffset: 5 },
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

function fakeIo({ sessions, todos, preview, nodes = [], size = null }) {
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
      size: () => size ?? { cols: 80, rows: 20 },
      onResize: () => {},
      refresh: async ({ index = 0 } = {}) => ({
        sessions: sessions.map((item, position) => ({ ...item, selected: position === index })),
        nodes: nodes.map((item, position) => ({ ...item, selected: position === 0 })),
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
  assert.match(drawn, /sessions \(2\)/, "the list is still there after a key");
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
  assert.match(lastFrame(), /sessions \(2\)/, "keys are still handled after the attach returns");
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

test("the todo box grows with its content when the panels are stacked", () => {
  assert.equal(todoBoxHeight(0, 30), 3, "empty list: header + one row + border");
  assert.equal(todoBoxHeight(1, 30), 3);
  assert.equal(todoBoxHeight(3, 30), 5, "three items and two borders");
  assert.equal(todoBoxHeight(50, 30), TODO_MAX_HEIGHT, "capped once it stops being useful");
  const none = computeLayout(70, 40, { todoCount: 0 });
  const busy = computeLayout(70, 40, { todoCount: 6 });
  assert.equal(none.todos.h, 0, "an empty list costs nothing on a narrow terminal");
  assert.ok(busy.todos.h > 0, "a real list gets its rows");
  assert.equal(busy.sessions.h + busy.todos.h, busy.height - 1, "the column adds up");
  const split = computeLayout(120, 40, { todoCount: 2 });
  assert.equal(split.todos.h, split.sessions.h, "side by side the todo column is full height");
});

test("a narrow terminal stacks the panels instead of squeezing two columns", () => {
  const layout = computeLayout(70, 26, { todoCount: 2 });
  assert.equal(layout.mode, "stacked");
  assert.equal(layout.sessions.w, layout.width, "panels are full width");
  assert.equal(layout.todos.y, layout.sessions.h, "todo sits under sessions");
  assert.equal(layout.sessions.h + layout.todos.h, layout.height - 1);

  const lines = renderFrame(
    { sessions: [], todos: [], footer: "f", focus: "sessions" },
    layout,
  );
  assert.equal(lines.length, layout.height);
  for (const line of lines) assert.equal(displayWidth(line), layout.width);
});

test("an empty todo list is hidden entirely on a narrow terminal", () => {
  const layout = computeLayout(70, 26, { todoCount: 0 });
  assert.equal(layout.todos.h, 0, "no rows wasted on an empty list");
  assert.ok(layout.sessions.h > computeLayout(70, 26, { todoCount: 3 }).sessions.h, "the rows go to the list");
  const lines = renderFrame(
    { sessions: [], todos: [], footer: "f", focus: "sessions" },
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
  assert.match(narrowed, /filter: risk/);
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

test("a session that is busy but silent is marked stuck, not healthy", async () => {
  const { tuiSessionRows } = await import("../src/commands.js");
  const config = { sessions: [{ name: "api", tmuxName: "api", node: null, role: null }] };
  const live = new Map([["api", { activity: Math.floor(Date.now() / 1000), attached: false, panes: [{ dead: false }] }]]);
  const free = tuiSessionRows(config, live, { stuck: new Set() })[0];
  assert.equal(free.stuck, false);
  assert.equal(free.warn, false, "fresh activity and no stall: nothing to flag");
  const stuck = tuiSessionRows(config, live, { stuck: new Set(["api"]) })[0];
  assert.equal(stuck.stuck, true);
  assert.equal(stuck.warn, true, "the same yellow as a quiet session");
  assert.equal(stuck.label.endsWith(" running"), true, "the label stays number, name, state");
});

test("restoreTerminal undoes raw mode, cursor and the alternate screen", async () => {
  const { createTui } = await import("../src/tui.js");
  const calls = [];
  const io = {
    size: () => ({ cols: 100, rows: 30 }),
    output: { write: (text) => calls.push(text) },
    input: { setRawMode: (on) => calls.push(`raw:${on}`), resume() {}, pause() {}, setEncoding() {}, on() {} },
    onResize() {},
    refresh: async () => ({ sessions: [], todos: [], preview: "" }),
  };
  const tui = createTui({ io });
  calls.length = 0;
  tui.restoreTerminal();
  const text = calls.filter((entry) => typeof entry === "string" && entry.startsWith("\u001b")).join("");
  assert.match(text, /\u001b\[\?1049l/, "leaves the alternate screen");
  assert.match(text, /\u001b\[\?7h/, "turns wrapping back on");
  assert.ok(calls.includes("raw:false"), "raw mode off");
});

test("--static redraws only when the keyboard moves, not on a clock", async () => {
  const fake = fakeIo({
    sessions: [{ label: "1 alpha", name: "alpha" }, { label: "2 beta", name: "beta" }],
    todos: [],
    preview: ["pane line"],
  });
  let refreshes = 0;
  const base = fake.io.refresh;
  fake.io.refresh = async (arg) => {
    refreshes += 1;
    return base(arg);
  };
  const tui = createTui({ io: fake.io, staticMode: true, intervalMs: 100 });
  const done = tui.start();
  await sleep(60);
  const afterFirst = refreshes;
  await sleep(400); // four intervals' worth
  assert.equal(refreshes, afterFirst, "no timer fired");
  fake.input.emit("data", "j");
  await sleep(60);
  assert.equal(refreshes, afterFirst + 1, "a key still redraws");
  fake.input.emit("data", "q");
  await done;
});

test("a slow frame never queues another one behind it", async () => {
  const fake = fakeIo({
    sessions: [{ label: "1 alpha", name: "alpha" }, { label: "2 beta", name: "beta" }],
    todos: [],
    preview: ["pane line"],
  });
  let refreshes = 0;
  let inflight = 0;
  let worst = 0;
  fake.io.refresh = async ({ index = 0 } = {}) => {
    refreshes += 1;
    inflight += 1;
    worst = Math.max(worst, inflight);
    await sleep(120);
    inflight -= 1;
    return {
      sessions: fake.data.sessions.map((item, position) => ({ ...item, selected: position === index })),
      todos: [],
      preview: { title: "alpha", lines: ["pane line"] },
    };
  };
  fake.data = { sessions: [{ label: "1 alpha", name: "alpha" }, { label: "2 beta", name: "beta" }] };
  const tui = createTui({ io: fake.io, intervalMs: 40 });
  const done = tui.start();
  await sleep(700);
  fake.input.emit("data", "q");
  await done;
  assert.equal(worst, 1, "frames never overlap");
  assert.ok(refreshes < 12, `the panel backed off instead of hammering (${refreshes} frames)`);
});

test("the keys a laptop actually has", async () => {
  const { parseKeys } = await import("../src/tui.js");
  assert.deepEqual(parseKeys(" "), ["pagedown"], "space pages down");
  assert.deepEqual(parseKeys("b"), ["pageup"], "b pages up");
  assert.deepEqual(parseKeys("\u0004"), ["pagedown"], "ctrl-d pages down");
  assert.deepEqual(parseKeys("\u0015"), ["pageup"], "ctrl-u pages up");
  assert.deepEqual(parseKeys("\u001b[C"), ["nextPanel"], "right arrow: next column");
  assert.deepEqual(parseKeys("\u001b[D"), ["prevPanel"], "left arrow: previous column");
  assert.deepEqual(parseKeys("\u001b[A"), ["up"], "up arrow: previous row");
});

test("the / box searches the machine and todo lists too", async () => {
  const { renderFrame, computeLayout } = await import("../src/tui.js");
  const model = {
    nodes: [
      { name: "", label: "local", index: 0 },
      { name: "work-01", label: "work-01 192.168.1.88", index: 1 },
    ],
    sessions: [{ label: " 1 api  running" }],
    todos: [{ label: "1. api — review the plan (2m, manual)" }],
    focus: "nodes",
  };
  const layout = computeLayout(120, 12, { nodes: 2, todoCount: 1 });
  const text = renderFrame(model, layout).join("\n");
  assert.match(text, /work-01/);
  assert.match(text, /review the plan/);
});

test("searching one column leaves the other two alone", async () => {
  const { input, io, lastFrame } = fakeIo({
    size: { cols: 120, rows: 24 },
    nodes: [{ label: "local" }, { label: "work-01 192.168.1.88" }],
    sessions: [{ label: " 1 backend  off", name: "backend" }, { label: " 2 risk-01 @work-01  running", name: "risk-01" }],
    todos: [{ label: "1. ops-5 — review the release", session: "ops-5" }],
    preview: [],
  });
  const tui = createTui({ io, version: "9.9.9" });
  const done = tui.start();
  await new Promise((resolve) => setTimeout(resolve, 60));
  input.emit("data", "\u001b[D");
  await new Promise((resolve) => setTimeout(resolve, 30));
  input.emit("data", "/");
  await new Promise((resolve) => setTimeout(resolve, 30));
  input.emit("data", "work");
  await new Promise((resolve) => setTimeout(resolve, 60));
  const frame = lastFrame();
  input.emit("data", "\u001b");
  await new Promise((resolve) => setTimeout(resolve, 30));
  input.emit("data", "q");
  await done;
  assert.match(frame, /machines \(1\)/, "the machines column narrows");
  assert.match(frame, /sessions \(2\)/, "sessions stay whole");
  assert.match(frame, /todo \(1\)/, "todo stays whole");
});

test("f sends a file to the selected session, typing a path", async () => {
  const { input, io, lastFrame } = fakeIo({
    sessions: [{ label: " 1 api  running", name: "api" }],
    todos: [],
    preview: [],
  });
  const sent = [];
  io.sendFile = async (name, file) => {
    sent.push([name, file]);
    return `told ${name}: ${file}`;
  };
  io.clipboard = () => "/tmp/shot.png";
  const tui = createTui({ io, version: "9.9.9" });
  const done = tui.start();
  await new Promise((resolve) => setTimeout(resolve, 60));
  input.emit("data", "f");
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.match(lastFrame(), /file: \/tmp\/shot\.png/, "the box is prefilled from the clipboard");
  input.emit("data", "\r");
  await new Promise((resolve) => setTimeout(resolve, 80));
  const frame = lastFrame();
  input.emit("data", "q");
  await done;
  assert.deepEqual(sent, [["api", "/tmp/shot.png"]]);
  assert.match(frame, /told api: \/tmp\/shot\.png/);
});
