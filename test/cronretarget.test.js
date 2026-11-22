import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { readJobs, setJobTarget } from "../src/cron.js";

function seed(jobs) {
  const dir = mkdtempSync(join(tmpdir(), "pp-retarget-"));
  const env = { ...process.env, XDG_STATE_HOME: dir };
  const file = join(dir, "pi-plus", "cron.json");
  mkdirSync(join(dir, "pi-plus"), { recursive: true });
  const body = JSON.stringify({ jobs });
  writeFileSync(file, body);
  return { env, file, body };
}

const every = { kind: "every", every: 300 };

test("retargeting a job moves its aim and keeps its history", () => {
  const { env } = seed([{ id: "aaaaaa", session: "w-old", prompt: "hi", schedule: every, runs: 7, lastRun: "2026-11-22T10:00:00.000Z" }]);
  assert.deepEqual(setJobTarget("aaaaaa", { session: "w2" }, env), {
    before: { session: "w-old", role: null },
    after: { session: "w2", role: null },
  });
  const [job] = readJobs(env);
  assert.equal(job.session, "w2");
  assert.equal(job.runs, 7);
  assert.equal(job.lastRun, "2026-11-22T10:00:00.000Z");
});

test("switching between session and role leaves only one target behind", () => {
  const { env } = seed([{ id: "bbbbbb", session: "w2", prompt: "hi", schedule: every, runs: 1 }]);
  assert.deepEqual(setJobTarget("bbbbbb", { role: "dev" }, env), {
    before: { session: "w2", role: null },
    after: { session: null, role: "dev" },
  });
  let [job] = readJobs(env);
  assert.equal(job.role, "dev");
  assert.equal("session" in job, false);

  setJobTarget("bbbbbb", { session: "*" }, env);
  [job] = readJobs(env);
  assert.equal(job.session, "*");
  assert.equal("role" in job, false);
});

test("an unknown id changes nothing and writes nothing", () => {
  const { env, file, body } = seed([]);
  assert.equal(setJobTarget("cccccc", { session: "w2" }, env), null);
  assert.equal(readFileSync(file, "utf8"), body);
});
