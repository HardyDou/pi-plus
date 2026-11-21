import assert from "node:assert/strict";
import test from "node:test";

import { describeNext } from "../src/commands.js";

test("a past due time reads as late, a future one as in", () => {
  const now = new Date("2026-11-21T10:00:00Z");
  // the clock in the parentheses is local time, so only the shape is asserted
  assert.match(describeNext(new Date("2026-11-21T10:03:00Z"), now).text, /^in 3m \(\d\d:\d\d\)$/);
  assert.equal(describeNext(new Date("2026-11-21T09:45:00Z"), now).late, true);
  assert.match(describeNext(new Date("2026-11-21T09:45:00Z"), now).text, /^late 15m \(\d\d:\d\d\)$/);
  assert.equal(describeNext(new Date("2026-11-21T10:00:02Z"), now).text.startsWith("in 2s"), true);
  assert.equal(describeNext(null, now).text, "-");
});
