import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dailyRuns, dayKey, recordRun, readJobs, tick, writeJobs } from "../src/cron.js";
import { deliveryPlan } from "../src/commands.js";

const sandbox = () => ({ ...process.env, XDG_STATE_HOME: mkdtempSync(join(tmpdir(), "cap-")) });
const job = (extra = {}) => ({
  id: "cccccc",
  action: "prompt",
  prompt: "hi",
  session: "*",
  schedule: { kind: "every", every: 60 },
  createdAt: new Date(Date.now() - 3600_000).toISOString(),
  runs: 0,
  ...extra,
});

test("a daily count resets when the day changes", () => {
  const j = { day: "2026-11-22", dayRuns: 7 };
  assert.equal(dailyRuns(j, new Date("2026-11-22T23:00:00")), 7);
  assert.equal(dailyRuns(j, new Date("2026-11-23T00:10:00")), 0, "a new day starts from zero");
  assert.equal(dayKey(new Date("2026-11-23T00:10:00")), "2026-11-23");
  assert.equal(dailyRuns({}, new Date()), 0);
});

test("a job stops delivering past its daily cap, and says why", () => {
  const env = sandbox();
  const base = Date.now() - 3600_000;
  writeJobs([job({ maxPerDay: 2 })], env);
  const run = (minute) => tick({ now: new Date(base + minute * 61_000), env, deliver: () => ({ status: "delivered" }) });

  assert.equal(run(1).ran.length, 1);
  assert.equal(run(2).ran.length, 1);
  const third = run(3);
  assert.equal(third.ran.length, 0, "the third delivery of the day is refused");
  assert.match(third.skipped[0].reason, /daily cap reached \(2\)/);
  const after = readJobs(env)[0];
  assert.equal(after.dayRuns, 2, "the counter does not move when nothing is sent");
  assert.equal(after.runs, 2);
});

test("cron run counts against the same cap", () => {
  const env = sandbox();
  writeJobs([job({ maxPerDay: 1 })], env);
  recordRun(readJobs(env)[0], "delivered", { env });
  const after = readJobs(env)[0];
  assert.equal(dailyRuns(after), 1);
  assert.equal(after.runs, 1);
});

test("the dry run reports the cap instead of promising a delivery", () => {
  const env = sandbox();
  const today = dayKey();
  const plan = deliveryPlan(
    { listSessions: () => new Map([["a", { name: "a", activity: 1 }]]) },
    { ...job({ maxPerDay: 1 }), day: today, dayRuns: 1 },
  );
  assert.equal(plan.targets[0].verdict, "cap");
  assert.equal(plan.targets[0].cap, 1);
});
