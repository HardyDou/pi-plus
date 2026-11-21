import assert from "node:assert/strict";
import { test } from "node:test";

import { describeNext } from "../src/commands.js";

// The job view is rendered inline in cmdWhyJob; what can be pinned down without
// a shell is the part that decides *when* it should have run, which is the
// source of every "why didn't it fire" answer.
test("describeNext says how late a job is, not just when it is due", () => {
  const now = new Date("2026-05-01T10:00:00Z");
  const past = describeNext(new Date("2026-05-01T09:45:00Z"), now);
  assert.equal(past.late, true);
  assert.match(past.text, /^late 15m/);

  const soon = describeNext(new Date("2026-05-01T10:03:00Z"), now);
  assert.equal(soon.late, false);
  assert.match(soon.text, /^in 3m/);

  const due = describeNext(now, now);
  assert.equal(due.late, false);
  assert.match(due.text, /^due now/);

  assert.equal(describeNext(null, now).text, "-");
});

test("a catch-up miss reads as a window, not as a timestamp in the past", () => {
  // the value behind the sentence: 7200s is what `pp cron add` defaults to, and
  // the message has to say "2h" rather than a clock time the user cannot use
  const now = new Date("2026-05-01T10:00:00Z");
  const missed = describeNext(new Date("2026-05-01T05:00:00Z"), now);
  assert.equal(missed.late, true);
  assert.match(missed.text, /^late 5h/);
});
