import test from "node:test";
import assert from "node:assert/strict";
import { cronRow, deferredFor, planSteps } from "../src/commands.js";

const now = new Date("2026-11-23T05:00:00.000Z");
const job = (extra = {}) => ({
  id: "aaaaaa",
  action: "prompt",
  prompt: "hi",
  session: "api",
  schedule: { kind: "every", every: 600 },
  createdAt: "2026-11-22T00:00:00.000Z",
  runs: 3,
  lastRun: "2026-11-23T04:40:00.000Z",
  lastAttempt: "2026-11-23T04:59:00.000Z",
  lastStatus: "deferred: api is working",
  deferredSince: "2026-11-23T02:40:00.000Z",
  ...extra,
});

test("a deferral carries its own age, not just the last attempt", () => {
  assert.equal(deferredFor(job(), now), 2 * 3600 * 1000 + 20 * 60 * 1000);
  assert.equal(deferredFor(job({ deferredSince: undefined }), now), 0);
  assert.equal(deferredFor(job({ deferredSince: "not a date" }), now), 0);
});

test("the table says since when, not just waiting", () => {
  const row = cronRow(job(), now);
  assert.match(row.next, /^waiting since \d\d:\d\d \(2h\)$/);
  assert.equal(row.deferred, true);
  assert.equal(row.deferredSince, "2026-11-23T02:40:00.000Z");
});

test("a long wait becomes a step, a short one does not", () => {
  const waiting = [{ id: "aaaaaa", session: "api", since: "2026-11-23T02:40:00.000Z", how: "2h" }];
  const steps = planSteps({ deferred: waiting });
  assert.equal(steps.length, 1);
  assert.match(steps[0].title, /aaaaaa has been waiting on api for 2h/);
  assert.equal(steps[0].command, "pp why aaaaaa");
  assert.deepEqual(planSteps({}), []);
});
