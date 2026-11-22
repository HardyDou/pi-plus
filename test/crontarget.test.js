import assert from "node:assert/strict";
import test from "node:test";
import { describeJobTarget } from "../src/commands.js";

const config = {
  nodes: [{ name: "t114" }],
  sessions: [
    { name: "w2", tmuxName: "w2-1", node: null, role: "dev" },
    { name: "api", tmuxName: "api", node: "t114", role: "dev" },
    { name: "docs", tmuxName: "docs", node: null, role: null },
  ],
};

test("a job aimed at a name that still exists says where it is and whether it runs", () => {
  const aim = describeJobTarget(config, { id: "aa11", session: "w2" }, { running: () => true });
  assert.equal(aim.ok, true);
  assert.equal(aim.text, "w2 — running", "no machine part when it runs here");

  const remote = describeJobTarget(config, { id: "aa12", session: "api" }, { running: () => false });
  assert.equal(remote.text, "api on t114 — not running — pp up api", "names the machine and the fix");

  const unknown = describeJobTarget(config, { id: "aa13", session: "docs" }, { running: () => null });
  assert.match(unknown.text, /state unknown/, "an unreachable machine is not 'down'");
});

test("a job aimed at a name that is gone points at retarget, not at rm", () => {
  const aim = describeJobTarget(config, { id: "aa21", session: "w-old" });
  assert.equal(aim.ok, false);
  assert.match(aim.text, /gone from the config/);
  assert.match(aim.text, /pp cron retarget aa21 --session <name>/);
});

test("role, broadcast, heal and sweep each describe their own address", () => {
  assert.equal(describeJobTarget(config, { id: "bb11", role: "dev" }).text, 'role "dev" — 2 session(s): w2, api');
  const dead = describeJobTarget(config, { id: "bb12", role: "ops" });
  assert.equal(dead.ok, false);
  assert.match(dead.text, /pp cron retarget bb12 --role <label>/);
  assert.equal(describeJobTarget(config, { id: "bb13", session: "*" }).text, "every session — 3 in the config");
  assert.match(describeJobTarget(config, { id: "bb14", action: "heal" }).text, /pp up --drift/);
  const sweep = describeJobTarget(config, { id: "bb15", action: "sweep", session: "docs" });
  assert.equal(sweep.text, "fleet report → docs");
  assert.equal(describeJobTarget(config, { id: "bb16", action: "sweep", session: "gone" }).ok, false);
});
