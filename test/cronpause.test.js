import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildSchedule, readJobs, setJobPaused, tick, writeJobs } from "../src/cron.js";

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), "pp-cronpause-"));
  return { XDG_STATE_HOME: dir };
}

const every = (minutes = 10) => buildSchedule({ every: String(minutes * 60) });

function job(id, overrides = {}) {
  return {
    id,
    session: "api",
    prompt: "stand up",
    schedule: every(),
    createdAt: new Date("2026-11-22T00:00:00Z").toISOString(),
    runs: 2,
    lastRun: new Date("2026-11-22T00:04:00Z").toISOString(),
    ...overrides,
  };
}

test("setJobPaused keeps the schedule and the history, and says whether it knew the job", () => {
  const env = sandbox();
  writeJobs([job("aaaaaa")], env);
  assert.equal(setJobPaused("nope", true, env), false);
  assert.equal(setJobPaused("aaaaaa", true, env), true);
  const [paused] = readJobs(env);
  assert.equal(paused.paused, true);
  assert.equal(paused.runs, 2, "history survives a pause");
  assert.equal(paused.lastRun, "2026-11-22T00:04:00.000Z");
  assert.equal(setJobPaused("aaaaaa", false, env), true);
  assert.equal(readJobs(env)[0].paused, undefined, "resuming removes the flag instead of setting false");
});

test("a paused job is skipped by the tick instead of delivered", () => {
  const env = sandbox();
  writeJobs([job("aaaaaa", { paused: true })], env);
  const delivered = [];
  const result = tick({
    now: new Date("2026-11-22T01:00:00Z"),
    env,
    deliver: (entry) => {
      delivered.push(entry.id);
      return { status: "delivered" };
    },
  });
  assert.deepEqual(delivered, []);
  assert.deepEqual(result.skipped.map((entry) => entry.reason), ["paused"]);
  const [after] = readJobs(env);
  assert.equal(after.lastRun, "2026-11-22T00:04:00.000Z", "a paused job does not pretend to have run");
  assert.equal(after.runs, 2);
});

test("resuming lets the next tick deliver again", () => {
  const env = sandbox();
  writeJobs([job("aaaaaa", { paused: true })], env);
  setJobPaused("aaaaaa", false, env);
  const delivered = [];
  tick({
    now: new Date("2026-11-22T01:00:00Z"),
    env,
    deliver: (entry) => {
      delivered.push(entry.id);
      return { status: "delivered" };
    },
  });
  assert.deepEqual(delivered, ["aaaaaa"]);
  assert.equal(readJobs(env)[0].runs, 3);
});
