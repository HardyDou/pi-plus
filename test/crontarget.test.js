import assert from "node:assert/strict";
import test from "node:test";
import { describeJobTarget, printCronJobs } from "../src/commands.js";

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

test("cron ls marks a job whose address is gone, and names the machine otherwise", () => {
  const rows = [];
  const ui = {
    out: (line) => rows.push(String(line)),
    info: () => {},
    warn: () => {},
    error: () => {},
    paint: (_style, text) => text,
  };
  const sessions = [
    { name: "web", tmuxName: "web", node: null, role: null },
    { name: "api", tmuxName: "api", node: "far", role: "pm" },
  ];
  const jobs = [
    { id: "aa0001", session: "web", role: null, action: "prompt", schedule: { kind: "every", every: 600 }, createdAt: "2026-11-22T09:55:00.000Z", runs: 0 },
    { id: "aa0002", session: "api", role: null, action: "prompt", schedule: { kind: "every", every: 600 }, createdAt: "2026-11-22T09:55:00.000Z", runs: 0 },
    { id: "aa0003", session: "gone", role: null, action: "prompt", schedule: { kind: "every", every: 600 }, createdAt: "2026-11-22T09:55:00.000Z", runs: 0 },
    { id: "aa0004", session: null, role: "qa", action: "prompt", schedule: { kind: "every", every: 600 }, createdAt: "2026-11-22T09:55:00.000Z", runs: 0 },
    { id: "aa0005", session: null, role: "pm", action: "prompt", schedule: { kind: "every", every: 600 }, createdAt: "2026-11-22T09:55:00.000Z", runs: 0 },
  ];
  printCronJobs(jobs, ui, new Date("2026-11-22T10:00:00Z"), sessions);
  const table = rows.filter((line) => line.startsWith("aa"));
  assert.match(table[0], /web {2,}every/, "a local session is named as written");
  assert.match(table[1], /api @far/, "a remote session shows its machine");
  assert.match(table[2], /gone !/, "a vanished session is flagged");
  assert.match(table[3], /role qa !/, "a role nobody carries is flagged");
  assert.match(table[4], /role pm /, "a role that is carried is not");
  assert.ok(rows.some((line) => /2 job\(s\) point at nothing — pp why aa0003/.test(line)), "one line says what to do next");
});

test("a long status stays readable: the verdict word in the table, the sentence elsewhere", () => {
  const rows = [];
  const ui = { out: (line) => rows.push(String(line)), info: () => {}, warn: () => {}, error: () => {}, paint: (_s, t) => t };
  const sessions = [{ name: "web", tmuxName: "web", node: null, role: null }];
  const jobs = [
    {
      id: "bb0001",
      session: "web",
      role: null,
      action: "prompt",
      schedule: { kind: "every", every: 600 },
      createdAt: new Date(Date.now() - 3600_000).toISOString(),
      runs: 3,
      lastStatus: "deferred: every session moved within 10m — nothing to nudge yet",
    },
  ];
  printCronJobs(jobs, ui, new Date(), sessions);
  const table = rows.find((line) => line.startsWith("bb0001") && line.includes("every 10m"));
  assert.match(table, /deferred …/, "the sentence is clipped, the verdict word survives");
  assert.ok(!table.includes("nothing to nudge yet"), "the full sentence is not in the table");
  assert.ok(rows.some((line) => /1 deferred — nothing was sent/.test(line)), "and one line explains it");
  assert.ok(!rows.some((line) => /past due/.test(line)), "a deferred job is not counted as a stalled tick");
});
