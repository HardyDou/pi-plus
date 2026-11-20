import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildSchedule,
  cronMatches,
  CronError,
  cronLogPath,
  describeSchedule,
  formatDuration,
  jobsPath,
  nextCronRun,
  nextRun,
  parseCron,
  parseDuration,
  readJobs,
  removeJob,
  resetJob,
  tick,
  writeJobs,
} from "../src/cron.js";

function stateHome() {
  const dir = mkdtempSync(join(tmpdir(), "pp-cron-"));
  process.env.XDG_STATE_HOME = dir;
  return { dir, env: { ...process.env, XDG_STATE_HOME: dir } };
}

test("paths follow XDG_STATE_HOME", () => {
  const { dir, env } = stateHome();
  assert.equal(jobsPath(env), join(dir, "pi-plus", "cron.json"));
  assert.equal(cronLogPath(env), join(dir, "pi-plus", "cron.log"));
});

test("cron parsing handles steps, lists, ranges and macros", () => {
  const every5 = parseCron("*/5 * * * *");
  assert.deepEqual([...every5.minutes].sort((a, b) => a - b), [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55]);
  assert.equal(every5.hours.size, 24);

  const weekly = parseCron("0 9 * * 1,2,3");
  assert.deepEqual([...weekly.dows].sort(), [1, 2, 3]);
  assert.deepEqual([...weekly.hours], [9]);

  assert.equal(parseCron("0 0 * * 0").source, "0 0 * * 0");
  assert.deepEqual([...parseCron("@daily").minutes], [0]);
  assert.deepEqual([...parseCron("0 9 * * mon-fri").dows].sort((a, b) => a - b), [1, 2, 3, 4, 5]);
  assert.deepEqual([...parseCron("0 9 * * 7").dows], [0], "7 is Sunday");
  assert.deepEqual([...parseCron("10-20/5 * * * *").minutes].sort((a, b) => a - b), [10, 15, 20]);
});

test("cron parsing rejects nonsense with readable errors", () => {
  assert.throws(() => parseCron("*/5 * * *"), CronError);
  assert.throws(() => parseCron("60 * * * *"), /out of range/);
  assert.throws(() => parseCron("5-1 * * * *"), /backwards range/);
  assert.throws(() => parseCron("*/0 * * * *"), /bad step/);
  assert.throws(() => parseCron("x * * * *"), /not a valid value/);
});

test("cronMatching and nextCronRun agree on weekdays at 09:00", () => {
  const weekly = parseCron("0 9 * * 1,2,3");
  // 2026-11-20 is a Friday; the next Monday is the 23rd.
  const from = new Date(2026, 10, 20, 12, 0, 0);
  const next = nextCronRun(weekly, from);
  assert.equal(next.getDay(), 1);
  assert.equal(next.getDate(), 23);
  assert.equal(next.getHours(), 9);
  assert.equal(next.getMinutes(), 0);
  assert.equal(cronMatches(weekly, next), true);
  assert.equal(cronMatches(weekly, new Date(2026, 10, 20, 9, 0, 0)), false, "Friday is not in 1,2,3");
});

test("nextCronRun finds the next step boundary for every-five-minutes", () => {
  const parsed = parseCron("*/5 * * * *");
  const next = nextCronRun(parsed, new Date(2026, 0, 1, 10, 3, 30));
  assert.equal(next.getMinutes(), 5);
  assert.equal(next.getSeconds(), 0);
});

test("durations parse and round-trip", () => {
  assert.equal(parseDuration("90"), 90);
  assert.equal(parseDuration("5m"), 300);
  assert.equal(parseDuration("2h"), 7200);
  assert.equal(parseDuration("1d"), 86400);
  assert.equal(formatDuration(300), "5m");
  assert.equal(formatDuration(7200), "2h");
  assert.throws(() => parseDuration("5 minutes please"), /not a duration/);
  assert.throws(() => parseDuration("5s"), /at least 30s/);
});

test("buildSchedule takes exactly one of at / every / cron", () => {
  const now = new Date("2026-11-20T10:00:00Z");
  assert.deepEqual(buildSchedule({ cron: "*/5 * * * *" }, now), { kind: "cron", cron: "*/5 * * * *" });
  assert.deepEqual(buildSchedule({ every: "5m" }, now), { kind: "every", every: 300 });
  const once = buildSchedule({ at: "2026-11-21T09:00:00Z" }, now);
  assert.equal(once.kind, "once");
  assert.equal(once.at, "2026-11-21T09:00:00.000Z");

  assert.throws(() => buildSchedule({}, now), /give a time/);
  assert.throws(() => buildSchedule({ at: "2026-11-21T09:00:00Z", every: "5m" }, now), /pick one of/);
  assert.throws(() => buildSchedule({ at: "2020-01-01T00:00:00Z" }, now), /in the past/);
  assert.throws(() => buildSchedule({ at: "tomorrow" }, now), /not a date/);
});

test("describeSchedule reads like a sentence", () => {
  assert.equal(describeSchedule({ kind: "every", every: 300 }), "every 5m");
  assert.equal(describeSchedule({ kind: "cron", cron: "0 9 * * 1,2,3" }), "cron 0 9 * * 1,2,3");
  assert.match(describeSchedule({ kind: "once", at: "2026-11-21T01:00:00.000Z" }), /^once at /);
});

test("nextRun advances with lastRun for intervals and cron", () => {
  const now = new Date("2026-11-20T10:00:00Z");
  const every = { schedule: { kind: "every", every: 300 }, createdAt: "2026-11-20T09:00:00.000Z" };
  assert.equal(nextRun(every, now).toISOString(), "2026-11-20T09:05:00.000Z");
  assert.equal(
    nextRun({ ...every, lastRun: "2026-11-20T09:30:00.000Z" }, now).toISOString(),
    "2026-11-20T09:35:00.000Z",
  );

  const once = { schedule: { kind: "once", at: "2026-11-21T09:00:00.000Z" }, createdAt: now.toISOString() };
  assert.equal(nextRun(once, now).toISOString(), "2026-11-21T09:00:00.000Z");
  assert.equal(nextRun({ ...once, lastRun: "2026-11-21T09:00:01.000Z" }, now), null);
});

test("tick delivers due jobs, prunes one-shots and keeps repeats", () => {
  const { env } = stateHome();
  const now = new Date("2026-11-20T10:00:00Z");
  writeJobs(
    [
      {
        id: "once1",
        action: "prompt",
        prompt: "hello",
        session: "s1",
        schedule: { kind: "once", at: "2026-11-20T09:59:00.000Z" },
        createdAt: "2026-11-20T08:00:00.000Z",
        catchUp: 7200,
        runs: 0,
      },
      {
        id: "rep1",
        action: "command",
        command: "true",
        schedule: { kind: "every", every: 300 },
        createdAt: "2026-11-20T09:50:00.000Z",
        catchUp: 7200,
        runs: 0,
      },
      {
        id: "later",
        action: "prompt",
        prompt: "not yet",
        session: "s1",
        schedule: { kind: "once", at: "2026-11-20T11:00:00.000Z" },
        createdAt: "2026-11-20T08:00:00.000Z",
        runs: 0,
      },
    ],
    env,
  );

  const delivered = [];
  const result = tick({ now, env, deliver: (job) => (delivered.push(job.id), { status: "delivered" }) });
  assert.deepEqual(delivered.sort(), ["once1", "rep1"]);
  assert.equal(result.ran.length, 2);
  const after = readJobs(env);
  assert.deepEqual(after.map((job) => job.id).sort(), ["later", "rep1"]);
  const rep = after.find((job) => job.id === "rep1");
  assert.equal(rep.runs, 1);
  assert.equal(rep.lastRun, now.toISOString());
});

test("tick skips jobs that are too late instead of firing them silently", () => {
  const { env } = stateHome();
  const now = new Date("2026-11-20T18:00:00Z");
  writeJobs(
    [
      {
        id: "stale",
        action: "prompt",
        prompt: "old",
        session: "s1",
        schedule: { kind: "once", at: "2026-11-20T09:00:00.000Z" },
        createdAt: "2026-11-19T09:00:00.000Z",
        catchUp: 600,
        runs: 0,
      },
    ],
    env,
  );
  let called = 0;
  const result = tick({ now, env, deliver: () => (called += 1, { status: "delivered" }) });
  assert.equal(called, 0);
  assert.equal(result.skipped.length, 1);
  assert.match(result.skipped[0].reason, /missed by 9h/);
  assert.equal(readJobs(env).length, 0, "a stale one-shot is dropped");
});

test("tick refuses to run twice at the same time", () => {
  const { env, dir } = stateHome();
  mkdirSync(join(dir, "pi-plus"), { recursive: true });
  writeFileSync(join(dir, "pi-plus", "cron.json.lock"), "someone else\n");
  const result = tick({ env, deliver: () => ({ status: "delivered" }) });
  assert.deepEqual(result, { skipped: true });
});

test("removeJob and resetJob", () => {
  const { env } = stateHome();
  const base = { action: "command", command: "true", createdAt: new Date().toISOString(), runs: 0, catchUp: 600 };
  writeJobs(
    [
      { id: "a", ...base, schedule: { kind: "every", every: 60 } },
      { id: "b", ...base, schedule: { kind: "every", every: 60 }, lastRun: new Date().toISOString() },
    ],
    env,
  );
  assert.equal(removeJob("a", env), true);
  assert.equal(removeJob("zz", env), false);
  assert.deepEqual(readJobs(env).map((job) => job.id), ["b"]);
  assert.equal(resetJob("b", env), true);
  assert.equal(readJobs(env)[0].lastRun, undefined);
  assert.ok(existsSync(jobsPath(env)));
});
