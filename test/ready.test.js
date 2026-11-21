import assert from "node:assert/strict";
import test from "node:test";

import { waitReady } from "../src/commands.js";
import { hasEditor } from "../src/tmux.js";

const rule = "─".repeat(60);
const readyScreen = `${rule}\n/tmp\n${rule}\n(opencode-go) deepseek`;
const busyScreen = `${rule}⠋ Working 3s\n/tmp\n${rule}\n(opencode-go) deepseek`;

const session = { name: "slow", tmuxName: "slow" };

const fake = (screens, { exists = true } = {}) => {
  let index = 0;
  return {
    sessionExists: () => exists,
    capture: () => screens[Math.min(index++, screens.length - 1)],
    editorDraft: () => "",
  };
};

test("an empty input box is a ready box", () => {
  assert.equal(hasEditor(readyScreen), true);
  assert.equal(hasEditor("just output\nno box yet"), false);
});

test("waitReady returns as soon as the box is drawn and nothing is spinning", async () => {
  const result = await waitReady(fake([readyScreen]), session, { timeoutMs: 200, intervalMs: 10 });
  assert.equal(result.ready, true);
  assert.ok(result.seconds >= 0);
});

test("a spinning agent is not ready, even with the box drawn", async () => {
  const result = await waitReady(fake([busyScreen]), session, { timeoutMs: 120, intervalMs: 20 });
  assert.equal(result.ready, false);
  assert.equal(result.reason, "still working");
});

test("it gives up with a reason instead of hanging when the box never appears", async () => {
  const result = await waitReady(fake(["booting…"]), session, { timeoutMs: 100, intervalMs: 20 });
  assert.equal(result.ready, false);
  assert.equal(result.reason, "no prompt yet");
});

test("a session that died while waiting is reported as such", async () => {
  const result = await waitReady(fake([readyScreen], { exists: false }), session, { timeoutMs: 100, intervalMs: 10 });
  assert.equal(result.ready, false);
  assert.equal(result.reason, "it is not running");
});
