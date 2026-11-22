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
