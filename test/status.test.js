import assert from "node:assert/strict";
import test from "node:test";

import { downReasons, formatDownReasons } from "../src/commands.js";

const row = (extra) => ({ state: "off", reason: "", cwdMissing: false, ...extra });

test("the footer says why sessions are down, not just how many", () => {
  const reasons = downReasons([
    row({ state: "running" }),
    row({ cwdMissing: true }),
    row({ reason: "hand" }),
    row({ reason: "hand" }),
    row({ state: "unreachable" }),
    row({ state: "dead" }),
    row({ reason: "drain" }),
  ]);
  // most common first, and the running session is not counted at all
  // ordered by how actionable the cause is, not by count
  assert.deepEqual(reasons, [
    { why: "cwd is gone", count: 1 },
    { why: "machine unreachable", count: 1 },
    { why: "agent exited", count: 1 },
    { why: "on a drained machine", count: 1 },
    { why: "stopped by hand", count: 2 },
  ]);
  const line = formatDownReasons(reasons);
  assert.equal(line, "6 down (1 cwd is gone, 1 machine unreachable, 1 agent exited, 2 more)");
  // nothing down → an empty breakdown, not "0 down"
  assert.deepEqual(downReasons([row({ state: "running" })]), []);
});

test("the breakdown stays short enough for the footer line", () => {
  const many = Array.from({ length: 9 }, (_, i) => row({ reason: i % 2 ? "hand" : "drain" }));
  const line = formatDownReasons(downReasons(many));
  assert.match(line, /^9 down \(/);
  assert.ok(line.length < 90, line);
});
