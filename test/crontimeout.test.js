import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { COMMAND_TIMEOUT_SECONDS, deliverJob } from "../src/commands.js";

const withState = (fn) => {
  const dir = mkdtempSync(join(tmpdir(), "pp-timeout-"));
  try {
    return fn({ XDG_STATE_HOME: dir, HOME: dir });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

test("a command job always has a deadline", () => {
  withState(() => {
    const started = Date.now();
    const result = deliverJob({ id: "t1", action: "command", command: "sleep 10", timeout: 1 }, {});
    const took = Date.now() - started;
    assert.match(result.status, /^failed: timed out after 1s$/);
    assert.ok(took < 5000, `the tick must not wait for the command (took ${took}ms)`);
  });
});

test("a command that fails says how, in words a log reader can act on", () => {
  withState(() => {
    assert.equal(deliverJob({ id: "t2", action: "command", command: "exit 3" }, {}).status, "failed: exit 3");
    assert.equal(deliverJob({ id: "t3", action: "command", command: "echo hi" }, {}).status, "delivered");
  });
});

test("without --timeout the default deadline is still finite", () => {
  // `never` would hang the tick forever; the default has to exist
  assert.ok(Number.isFinite(COMMAND_TIMEOUT_SECONDS) && COMMAND_TIMEOUT_SECONDS > 0);
  assert.equal(COMMAND_TIMEOUT_SECONDS, 300);
});

test("a failing command keeps the tail of what it said", async () => {
  const { deliverJob, firstLine } = await import("../src/commands.js");
  const result = deliverJob({ id: "abc123", action: "command", command: "printf 'a\\nb\\nboom\\n' >&2; exit 3", timeout: 10 }, {});
  assert.equal(result.status, "failed: exit 3 — a");
  assert.match(result.output, /boom/);
  const saved = [];
  const { recordRun } = await import("../src/cron.js");
  const job = { id: "abc123", action: "command", command: "x", schedule: { kind: "every", every: 60 }, runs: 0 };
  recordRun(job, result.status, { output: result.output, env: { ...process.env, XDG_STATE_HOME: process.env.PP_TEST_STATE } });
  assert.match(job.lastOutput, /boom/, "the last lines are kept for pp why");
  recordRun(job, "delivered", { env: { ...process.env, XDG_STATE_HOME: process.env.PP_TEST_STATE } });
  assert.equal(job.lastOutput, undefined, "a good run clears it");
  assert.equal(firstLine("\n\n  a long line  \n", 6), "a lon…", "trimmed, clipped to the limit");
  assert.equal(firstLine("\n\n  a long line  \n", 40), "a long line");
});
