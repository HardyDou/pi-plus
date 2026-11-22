import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CLI = join(ROOT, "bin", "pp.js");

const sandbox = () => {
  const dir = mkdtempSync(join(tmpdir(), "set2-"));
  mkdirSync(join(dir, "pi-plus"), { recursive: true });
  writeFileSync(
    join(dir, "pi-plus", "cron.json"),
    JSON.stringify({
      jobs: [
        {
          id: "aaaaaa",
          action: "prompt",
          prompt: "old text",
          session: "*",
          schedule: { kind: "every", every: 600 },
          createdAt: "2026-11-20T00:00:00.000Z",
          runs: 12,
          lastRun: "2026-11-22T23:50:00.000Z",
        },
      ],
    }),
  );
  return { ...process.env, XDG_STATE_HOME: dir };
};
const run = (env, args) => spawnSync(process.execPath, [CLI, "cron", ...args], { env, encoding: "utf8" });
const jobs = (env) => JSON.parse(readFileSync(join(env.XDG_STATE_HOME, "pi-plus", "cron.json"), "utf8")).jobs;

test("the schedule can change without losing the counts", () => {
  const env = sandbox();
  const result = run(env, ["set", "aaaaaa", "--every", "30m"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /schedule: every 10m -> every 30m/);
  const job = jobs(env)[0];
  assert.deepEqual(job.schedule, { kind: "every", every: 1800 });
  assert.equal(job.runs, 12);
  assert.equal(job.lastRun, "2026-11-22T23:50:00.000Z", "an interval edit measures from the last run");
});

test("the prompt can be replaced, and the change is quiet when nothing differs", () => {
  const env = sandbox();
  const changed = run(env, ["set", "aaaaaa", "--prompt", "new text"]);
  assert.equal(changed.status, 0);
  assert.match(changed.stdout, /prompt: old text -> new text/);
  assert.equal(jobs(env)[0].prompt, "new text");
  const same = run(env, ["set", "aaaaaa", "--prompt", "new text"]);
  assert.equal(same.status, 0);
  assert.match(same.stdout, /nothing changes/);
});

test("switching to a one-shot forgets the old run so it can fire", () => {
  const env = sandbox();
  const when = new Date(Date.now() + 3600_000).toISOString();
  const result = run(env, ["set", "aaaaaa", "--at", when]);
  assert.equal(result.status, 0, result.stderr);
  const job = jobs(env)[0];
  assert.equal(job.schedule.kind, "once");
  assert.equal(job.lastRun, undefined);
  assert.equal(job.done, undefined);
});

test("two schedule flags at once is a usage error", () => {
  const env = sandbox();
  const result = run(env, ["set", "aaaaaa", "--every", "5m", "--cron", "*/10 * * * *"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /pick one of --every, --cron, --in, --at/);
});
