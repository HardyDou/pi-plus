import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { stallWatch } from "../src/commands.js";

const rule = "─".repeat(60);
// pi draws the status line right after a rule, starting with the spinner glyph:
// that is exactly what `looksBusy` keys on
const frame = (spinner, seconds) => ["transcript", `${rule}${spinner} Working ${seconds}s`, rule, "› "].join("\n");
const idle = ["transcript", rule, "finished", rule, "› "].join("\n");
const tmuxOf = (text) => ({ capture: () => text });

const config = { path: "/tmp/pi-plus-stall.yml" };

const withState = (fn) => {
  const dir = mkdtempSync(join(tmpdir(), "pp-stall-"));
  try {
    return fn({ XDG_STATE_HOME: dir, HOME: dir });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

test("an idle agent is not watched at all", () => {
  withState((env) => {
    const reading = stallWatch(config, tmuxOf(idle), { name: "web" }, { env });
    assert.deepEqual(reading, { name: "web", busy: false, quiet: 0 });
  });
});

test("quiet minutes count from the last frame that changed", () => {
  withState((env) => {
    const t0 = Date.parse("2026-11-21T10:00:00.000Z");
    // first sighting: nothing to compare against, so the clock starts now
    assert.ok(frame("⠋", 1).includes("─⠋"), "the synthetic frame has to look like a real one");
    const first = stallWatch(config, tmuxOf(frame("⠋", 1)), { name: "web" }, { env, now: t0 });
    assert.equal(first.busy, true);
    assert.equal(first.quiet, 0);

    // same screen four minutes later: the agent has not drawn anything new
    const stuck = stallWatch(config, tmuxOf(frame("⠋", 1)), { name: "web" }, { env, now: t0 + 4 * 60000 });
    assert.equal(stuck.quiet, 4);
    assert.equal(stuck.busyMinutes, 4);

    // a new frame (the spinner advanced) resets it — this is the whole point:
    // a long build that keeps printing is *not* stuck
    const alive = stallWatch(config, tmuxOf(frame("⠙", 9)), { name: "web" }, { env, now: t0 + 5 * 60000 });
    assert.equal(alive.quiet, 0);
    assert.equal(alive.busyMinutes, 5);
  });
});
