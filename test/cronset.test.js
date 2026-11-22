import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readJobs, updateJob, writeJobs } from "../src/cron.js";

const sandbox = () => ({ ...process.env, XDG_STATE_HOME: mkdtempSync(join(tmpdir(), "set-")) });
const seed = (env) =>
  writeJobs(
    [
      {
        id: "aaaaaa",
        action: "prompt",
        prompt: "hi",
        session: "*",
        schedule: { kind: "every", every: 600 },
        createdAt: "2026-11-20T00:00:00.000Z",
        runs: 41,
        lastRun: "2026-11-22T23:50:00.000Z",
        idleAfter: 600,
      },
    ],
    env,
  );

test("a change keeps the id, the schedule and the counts", () => {
  const env = sandbox();
  seed(env);
  const result = updateJob("aaaaaa", { maxPerDay: 96 }, env);
  assert.deepEqual(result, { before: { maxPerDay: null }, after: { maxPerDay: 96 } });
  const job = readJobs(env)[0];
  assert.equal(job.maxPerDay, 96);
  assert.equal(job.runs, 41, "history survives an edit");
  assert.equal(job.lastRun, "2026-11-22T23:50:00.000Z");
  assert.deepEqual(job.schedule, { kind: "every", every: 600 });
  assert.equal(job.idleAfter, 600, "untouched knobs stay");
});

test("null removes a knob", () => {
  const env = sandbox();
  seed(env);
  updateJob("aaaaaa", { idleAfter: null }, env);
  assert.equal("idleAfter" in readJobs(env)[0], false);
});

test("an unknown job is a miss, not a crash", () => {
  const env = sandbox();
  seed(env);
  assert.equal(updateJob("nonexistent", { maxPerDay: 1 }, env), null);
  assert.equal(readJobs(env)[0].maxPerDay, undefined);
});
