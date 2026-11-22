import assert from "node:assert/strict";
import test from "node:test";

import { danglingRoleJobs, danglingSessionJobs } from "../src/commands.js";

const config = {
  sessions: [
    { name: "api", tmuxName: "api", role: "dev" },
    { name: "web", tmuxName: "web-1", role: null },
  ],
};

test("a job aimed at a session the config no longer has is a finding", () => {
  const jobs = [
    { id: "aaaaaa", session: "api" },
    { id: "bbbbbb", session: "web-1" }, // tmux name counts, not just the config name
    { id: "cccccc", session: "web" },
    { id: "dddddd", session: "old-name" },
  ];
  assert.deepEqual(danglingSessionJobs(jobs, config).map((job) => job.id), ["dddddd"]);
});

test("fleet-wide, role and action jobs are not dangling by definition", () => {
  const jobs = [
    { id: "aaaaaa", session: "*" },
    { id: "bbbbbb", session: null, role: "qa" },
    { id: "cccccc", session: "gone", action: "command" },
    { id: "dddddd", session: null, action: "heal" },
    { id: "eeeeee", session: null, action: "sweep" },
  ];
  assert.deepEqual(danglingSessionJobs(jobs, config), []);
  assert.deepEqual(danglingRoleJobs(jobs, config).map((job) => job.id), ["bbbbbb"], "a role nothing carries still counts");
  assert.deepEqual(danglingSessionJobs(jobs, null), [], "no config, nothing to compare against");
});
