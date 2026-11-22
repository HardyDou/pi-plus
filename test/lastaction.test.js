import assert from "node:assert/strict";
import test from "node:test";

import { lastActionLine } from "../src/tmux.js";

const rule = "─".repeat(60);
const pane = (transcript, tail = `${rule}⠹ Working 6m 14s${rule}\n${rule}\n/data/work • pp\n↑9.1M ↓1.9M R611M CH99.8% $4.3 15.8%/1.0M\n› `) =>
  [...transcript, "", tail].join("\n");

test("the last line of the transcript, not the chrome", () => {
  assert.equal(lastActionLine(pane(["  ✓ npm test (12s)", "  read config.ts"])), "read config.ts");
});

test("status line, spinner and elapsed counter are not 'what it is doing'", () => {
  assert.equal(lastActionLine(pane(["  ✓ npm test (12s)", "  Elapsed 6m 14s"])), "✓ npm test (12s)");
  assert.equal(lastActionLine(pane(["", `${rule}⠋ Working 1s${rule}`, rule, "› "])), "");
});

test("long lines are clipped so the table stays a table", () => {
  const long = `  ${"x".repeat(120)}`;
  const line = lastActionLine(pane([long]), 40);
  assert.equal(line.length, 40);
  assert.ok(line.endsWith("…"));
});
