import assert from "node:assert/strict";
import test from "node:test";
import { editorDraft, looksBusy, sameDraft, screenSignature, Tmux } from "../src/tmux.js";

const rule = "─".repeat(60);

/** A pi screen: transcript, the input box between two rules, then the status lines. */
function screen(box = [], status = ["/data/Mango/mango (main) • 发布mango", "↑6.7M ↓1.2M"]) {
  return ["previous line of transcript", rule, ...box, rule, ...status].join("\n");
}

const emptyBox = screen();
const busyRule = `── ⠋ Working ${"─".repeat(40)}`;
const busyScreen = screen([], ["previous line", busyRule]);

/** Records tmux invocations and replays a scripted sequence of screens. */
class FakeTmux extends Tmux {
  constructor(screens) {
    super({});
    this.calls = [];
    this.screens = [...screens];
  }

  run(args) {
    this.calls.push(args.join(" "));
    return { status: 0, stdout: "", stderr: "" };
  }

  capture() {
    return this.screens.length > 1 ? this.screens.shift() : this.screens[0];
  }

  enters() {
    return this.calls.filter((call) => call.endsWith(" Enter")).length;
  }

  typed() {
    return this.calls.filter((call) => call.includes("-l --")).length;
  }
}

test("screenSignature ignores colours, padding and the tail beyond six lines", () => {
  assert.equal(screenSignature("\u001b[7m│ 1 alpha │\u001b[0m   \n\n"), screenSignature("│ 1 alpha │"));
  const lines = Array.from({ length: 10 }, (_, index) => `line-${index}`).join("\n");
  assert.ok(screenSignature(lines).startsWith("line-4"), "only the last six lines count");
});

test("editorDraft reads the box between the last two rules", () => {
  assert.equal(editorDraft(emptyBox), "", "an empty box has nothing waiting");
  assert.match(editorDraft(screen(["巡检提示词", "第二行"])), /^巡检提示词\n第二行$/);
  assert.equal(editorDraft("bash$ "), "", "a screen without rules has no box");
});

test("looksBusy sees the spinner pi draws while a turn runs", () => {
  assert.equal(looksBusy(busyScreen), true);
  assert.equal(looksBusy(emptyBox), false, "an idle screen has no braille spinner");
  assert.equal(looksBusy(screen(["⣿ in my own draft"])), false, "draft text is not a spinner");
});

test("sameDraft survives the wrapping pi adds to long drafts", () => {
  assert.equal(sameDraft("巡检提示词\n第二行", "巡检提示词 第二行"), true);
  assert.equal(sameDraft("别的东西", "巡检提示词"), false);
});

test("sendText presses Enter once when the box empties", () => {
  const tmux = new FakeTmux([emptyBox, emptyBox]);
  const result = tmux.sendText("alpha", "巡检提示词", { settleMs: 0 });
  assert.equal(result.submitted, true);
  assert.equal(result.retries, 0);
  assert.equal(result.reused, false);
  assert.equal(tmux.enters(), 1);
  assert.equal(tmux.typed(), 1);
  assert.ok(tmux.calls[0].includes("-l -- 巡检提示词"));
});

test("sendText presses Enter again when the first one was swallowed", () => {
  const tmux = new FakeTmux([emptyBox, screen(["巡检提示词"]), emptyBox]);
  const result = tmux.sendText("alpha", "巡检提示词", { settleMs: 0 });
  assert.equal(result.submitted, true, "the extra Enter rescued it");
  assert.equal(result.retries, 1);
  assert.equal(tmux.enters(), 2);
});

test("sendText does not type a prompt that is already waiting in the box", () => {
  const tmux = new FakeTmux([screen(["巡检提示词", "第二行"]), emptyBox]);
  const result = tmux.sendText("alpha", "巡检提示词 第二行", { settleMs: 0 });
  assert.equal(result.reused, true, "the text was already in the editor");
  assert.equal(tmux.typed(), 0, "typing it again is how the box filled up before");
  assert.equal(result.submitted, true);
  assert.equal(tmux.enters(), 1);
});

test("sendText gives up and says so when Enter never takes", () => {
  const tmux = new FakeTmux([emptyBox, screen(["巡检提示词"])]);
  const result = tmux.sendText("alpha", "巡检提示词", { settleMs: 0 });
  assert.equal(result.submitted, false, "three retries, then an honest failure");
  assert.equal(result.retries, 3);
  assert.match(result.screen, /巡检提示词/, "the pane is quoted back for the log");
  assert.equal(tmux.enters(), 4);
});

test("sendText with --no-enter types and stops", () => {
  const tmux = new FakeTmux([emptyBox]);
  const result = tmux.sendText("alpha", "hi", { enter: false });
  assert.equal(result.submitted, false);
  assert.equal(result.typed, true);
  assert.equal(tmux.enters(), 0);
  assert.equal(tmux.calls.length, 1);
});
