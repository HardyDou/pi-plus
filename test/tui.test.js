import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import {
  computeLayout,
  createTui,
  displayWidth,
  moveSelection,
  padWidth,
  parseKeys,
  renderFrame,
  stripAnsi,
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
  const layout = computeLayout(80, 20);
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

test("renderFrame scrolls the todo list with todoOffset", () => {
  const layout = computeLayout(80, 24);
  const todos = Array.from({ length: 20 }, (_, index) => ({ label: `todo-${index}` }));
  const lines = renderFrame(
    { sessions: [], todos, preview: { title: "—", lines: [] }, focus: "todos", footer: "", todoOffset: 5 },
    layout,
  );
  const text = lines.map(plain).join("\n");
  assert.match(text, /todo-5/);
  assert.doesNotMatch(text, /todo-0 /);
});

test("moveSelection clamps to the list", () => {
  assert.equal(moveSelection(0, 3, -1), 0);
  assert.equal(moveSelection(2, 3, 1), 2);
  assert.equal(moveSelection(1, 3, 1), 2);
  assert.equal(moveSelection(0, 0, 1), 0);
});

function fakeIo({ sessions, todos, preview }) {
  const input = new EventEmitter();
  input.setRawMode = () => {};
  input.resume = () => {};
  input.pause = () => {};
  input.setEncoding = () => {};
  let buffer = "";
  const output = {
    write(chunk) {
      buffer += chunk;
      return true;
    },
  };
  return {
    input,
    output,
    text: () => stripAnsi(buffer),
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
