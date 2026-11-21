import assert from "node:assert/strict";
import test from "node:test";

import { overdueJobs } from "../src/commands.js";

const now = new Date("2026-11-21T10:00:00.000Z");
const job = (extra) => ({
  id: "aaaaaa",
  session: "web",
  schedule: { kind: "every", every: 600 },
  createdAt: "2026-11-21T08:00:00.000Z",
  lastRun: "2026-11-21T09:40:00.000Z", // due at 09:50, 10m late
  ...extra,
});

test("a job past its next run is late, and says by how much", () => {
  const [late] = overdueJobs([job()], now);
  assert.equal(late.id, "aaaaaa");
  assert.equal(late.late, "10m");
});

test("a deferred job is not late: the tick fired, the pane was busy", () => {
  const jobs = [job({ lastStatus: "deferred: web is working — the next tick will deliver" })];
  assert.deepEqual(overdueJobs(jobs, now), []);
});

test("a finished one-shot and a job that is merely due are both quiet", () => {
  assert.deepEqual(overdueJobs([job({ done: true })], now), []);
  assert.deepEqual(overdueJobs([job({ lastRun: "2026-11-21T09:59:30.000Z" })], now), []); // due 10:09:30
  // grace: less than a minute past due is just the tick's own clock skew
  assert.deepEqual(overdueJobs([job({ lastRun: "2026-11-21T09:50:30.000Z" })], now), []);
});

test("the oldest one comes first, because that is the one to look at", () => {
  const late = overdueJobs([job({ id: "bbbbbb" }), job({ id: "cccccc", lastRun: "2026-11-21T08:30:00.000Z" })], now);
  assert.deepEqual(
    late.map((entry) => entry.id),
    ["cccccc", "bbbbbb"],
  );
});
