import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { readJobs, tick, writeJobs } from "../src/cron.js";

test("a job missed beyond the catch-up window is skipped once, then resynced", () => {
  const dir = mkdtempSync(join(tmpdir(), "pp-cron-"));
  const env = { XDG_STATE_HOME: dir, HOME: dir };
  try {
    const longAgo = new Date(Date.now() - 5 * 3600 * 1000).toISOString();
    writeJobs(
      [
        {
          id: "aaaaaa",
          session: "web",
          action: "prompt",
          prompt: "ping",
          schedule: { kind: "every", every: 600 },
          createdAt: longAgo,
          lastRun: longAgo,
          catchUp: 7200,
        },
      ],
      env,
    );

    let delivered = 0;
    const first = tick({ env, deliver: () => (delivered += 1, { status: "delivered" }) });
    assert.equal(delivered, 0, "no delivery, the catch-up window is long gone");
    assert.equal(first.skipped.length, 1);
    assert.match(first.skipped[0].reason, /missed by/);

    // the schedule moved forward: the next run is now in the future, so the job
    // is no longer permanently "late" and the next tick is a normal one
    const [job] = readJobs(env);
    assert.ok(Date.parse(job.lastRun) > Date.now() - 5000, "lastRun was resynced to now");

    const second = tick({ env, deliver: () => (delivered += 1, { status: "delivered" }) });
    assert.equal(delivered, 0, "ten minutes later is still ten minutes later");
    assert.equal(second.skipped.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
