import test from "node:test";
import assert from "node:assert/strict";
import {
  BLOCK_BEGIN,
  BLOCK_END,
  blockLines,
  blockStatus,
  hasBlock,
  installBlock,
  readCrontab,
  stripBlock,
  uninstallBlock,
} from "../src/crond.js";

const SCRIPT = "/nvm/bin/pp.js";
const NODE = "/nvm/bin/node";
const CRON = () => "*/5 * * * * /usr/local/bin/backup.sh\nMAILTO=bob@example.com";

/** A crontab(1) stand-in that records what would be written. */
function fakeRun(initial, { status = 0, stderr = "" } = {}) {
  const calls = [];
  const state = { text: initial };
  const run = (cmd, args, options) => {
    calls.push({ cmd, args, input: options?.input });
    if (cmd !== "crontab") return { status: 127, stderr: "no such command" };
    if (args[0] === "-l") {
      if (status !== 0) return { status, stderr };
      return { status: 0, stdout: state.text };
    }
    state.text = options.input;
    return { status: 0, stdout: "" };
  };
  return { run, calls, state };
}

test("a machine with no crontab is not an error", () => {
  const { run } = fakeRun("", { status: 1, stderr: "no crontab for bob" });
  assert.equal(readCrontab(run), "");
});

test("a real crontab failure is an error", () => {
  const { run } = fakeRun("", { status: 1, stderr: "crontab: permission denied" });
  assert.throws(() => readCrontab(run), /crontab -l failed: crontab: permission denied/);
});

test("install keeps every other line and is idempotent", () => {
  const { run, state } = fakeRun(CRON());
  const first = installBlock({ scriptPath: SCRIPT, nodePath: NODE, run });
  assert.equal(first.changed, true);
  assert.match(state.text, /\*\/5 \* \* \* \* \/usr\/local\/bin\/backup\.sh/);
  assert.match(state.text, /MAILTO=bob@example.com/);
  assert.ok(state.text.includes(BLOCK_BEGIN));

  const second = installBlock({ scriptPath: SCRIPT, nodePath: NODE, run });
  assert.equal(second.changed, false, "a second install writes nothing new");
  assert.equal(state.text, first.crontab);
});

test("install replaces an outdated block instead of stacking a second one", () => {
  const stale = `${CRON()}\n\n${BLOCK_BEGIN}\n* * * * * old command\n${BLOCK_END}`;
  const { run, state } = fakeRun(stale);
  installBlock({ scriptPath: SCRIPT, nodePath: NODE, run });
  assert.equal(state.text.split(BLOCK_BEGIN).length - 1, 1);
  assert.ok(!state.text.includes("old command"));
});

test("the block carries both the minute tick and the boot catch-up", () => {
  const { run, state } = fakeRun("");
  installBlock({ scriptPath: SCRIPT, nodePath: NODE, run });
  const status = blockStatus(state.text);
  assert.deepEqual([status.installed, status.tick, status.reboot], [true, true, true]);
  assert.equal(blockLines(state.text).length, 2);
});

test("paths with spaces and quotes survive being put in a crontab", () => {
  const { run, state } = fakeRun("");
  installBlock({ scriptPath: '/srv/my "pp"/pp.js', nodePath: "/usr/bin/node", run });
  assert.ok(state.text.includes('"/srv/my \\"pp\\"/pp.js"'));
});

test("a PATH line is deduplicated but every entry survives", () => {
  const { run, state } = fakeRun("");
  installBlock({ scriptPath: SCRIPT, nodePath: NODE, env: { PATH: "/a:/b:/a" }, run });
  assert.ok(state.text.includes('PATH="/a:/b"'));
});

test("uninstall removes the block and nothing else", () => {
  const { run, state } = fakeRun(CRON());
  installBlock({ scriptPath: SCRIPT, nodePath: NODE, run });
  const removed = uninstallBlock({ run });
  assert.equal(removed.removed, true);
  assert.ok(!state.text.includes(BLOCK_BEGIN));
  assert.match(state.text, /backup\.sh/);
  assert.match(state.text, /MAILTO/);
});

test("uninstall on a crontab without the block changes nothing", () => {
  const { run, calls } = fakeRun(CRON());
  const removed = uninstallBlock({ run });
  assert.equal(removed.removed, false);
  assert.equal(calls.filter((call) => call.args[0] === "-").length, 0, "no write happened");
});

test("dry-run never writes", () => {
  const { run, state } = fakeRun(CRON());
  const result = installBlock({ scriptPath: SCRIPT, nodePath: NODE, dryRun: true, run });
  assert.equal(result.changed, true);
  assert.equal(state.text, CRON());
});

test("stripBlock tolerates a half-written block", () => {
  const text = `${CRON()}\n${BLOCK_BEGIN}\n* * * * * half a block`;
  assert.ok(!stripBlock(text).includes(BLOCK_BEGIN));
  assert.ok(stripBlock(text).includes("backup.sh"));
});
