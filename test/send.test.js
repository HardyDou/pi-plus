import assert from "node:assert/strict";
import test from "node:test";
import { screenSignature, Tmux } from "../src/tmux.js";

/** Records tmux invocations and replays a scripted sequence of screens. */
class FakeTmux extends Tmux {
  constructor(screens) {
    super({});
    this.calls = [];
    this.screens = [...screens];
    this.text = "";
  }

  run(args) {
    this.calls.push(args.join(" "));
    if (args[0] === "send-keys" && args.includes("-l")) this.text = args[args.length - 1];
    return { status: 0, stdout: "", stderr: "" };
  }

  capture() {
    return this.screens.length > 1 ? this.screens.shift() : this.screens[0];
  }

  enters() {
    return this.calls.filter((call) => call.endsWith(" Enter")).length;
  }
}

const draft = "❯ 巡检提示词\n      正在等待发送";
const submitted = "❯ 巡检提示词\n\n⠧ Working";

test("screenSignature ignores colours, padding and the tail beyond six lines", () => {
  assert.equal(screenSignature("\u001b[7m│ 1 alpha │\u001b[0m   \n\n"), screenSignature("│ 1 alpha │"));
  const lines = Array.from({ length: 10 }, (_, index) => `line-${index}`).join("\n");
  assert.ok(screenSignature(lines).startsWith("line-4"), "only the last six lines count");
});

test("sendText presses Enter once when the screen moves", () => {
  const tmux = new FakeTmux([draft, submitted, submitted]);
  const result = tmux.sendText("alpha", "巡检提示词", { settleMs: 0 });
  assert.equal(result.submitted, true);
  assert.equal(result.retries, 0);
  assert.equal(tmux.enters(), 1);
  assert.ok(tmux.calls[0].includes("-l -- 巡检提示词"));
});

test("sendText presses Enter again when a paste swallowed the first one", () => {
  const tmux = new FakeTmux([draft, draft, submitted]);
  const result = tmux.sendText("alpha", "巡检提示词", { settleMs: 0 });
  assert.equal(result.submitted, true, "the extra Enter rescued it");
  assert.equal(result.retries, 1);
  assert.equal(tmux.enters(), 2);
});

test("sendText gives up and says so when Enter never takes", () => {
  const tmux = new FakeTmux([draft]);
  const result = tmux.sendText("alpha", "巡检提示词", { settleMs: 0 });
  assert.equal(result.submitted, false, "three retries, then an honest failure");
  assert.equal(result.retries, 3);
  assert.match(result.screen, /等待发送/, "the pane is quoted back for the log");
  assert.equal(tmux.enters(), 4);
});

test("sendText with --no-enter types and stops", () => {
  const tmux = new FakeTmux([draft]);
  assert.deepEqual(tmux.sendText("alpha", "hi", { enter: false }), { submitted: false, retries: 0 });
  assert.equal(tmux.enters(), 0);
  assert.equal(tmux.calls.length, 1);
});
