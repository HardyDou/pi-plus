import assert from "node:assert/strict";
import test from "node:test";

import { grepLines } from "../src/commands.js";

const text = "build start\nstep 1\nstep 2\nERROR boom\nstep 3\nstep 4\nerror late\nstep 5\n";

test("grep keeps the matching lines and the context around them", () => {
  const exact = grepLines(text, "ERROR");
  assert.equal(exact.matches, 1);
  // a leading "…" says lines above were skipped, which is the thing people
  // need to know before screenshotting the output into a ticket
  assert.equal(exact.text, "…\nERROR boom");

  const around = grepLines(text, "ERROR", { context: 1 });
  // the skipped head and tail are marked, not silently dropped
  assert.equal(around.text, "…\nstep 2\nERROR boom\nstep 3");

  const caseInsensitive = grepLines(text, "error", { ignoreCase: true });
  assert.equal(caseInsensitive.matches, 2);
  assert.match(caseInsensitive.text, /error late/);
});

test("adjacent blocks are joined instead of double-marked", () => {
  const close = grepLines("a\nERROR one\nERROR two\nb", "ERROR");
  assert.equal(close.matches, 2);
  assert.equal(close.text, "…\nERROR one\nERROR two");

  const withContext = grepLines("a\nERROR one\nb\nERROR two\nc", "ERROR", { context: 1 });
  // the two windows overlap on "b": it appears once, and with the whole pane
  // kept there is nothing to mark as skipped
  assert.equal(withContext.text, "…\na\nERROR one\nb\nERROR two\nc");
});

test("no match is empty, and counts are match lines not printed lines", () => {
  const none = grepLines(text, "nothing-here");
  assert.equal(none.matches, 0);
  assert.equal(none.text, "");
  const wide = grepLines(text, "step", { context: 2 });
  assert.equal(wide.matches, 5);
});
