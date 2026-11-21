import assert from "node:assert/strict";
import test from "node:test";

import { startSummary } from "../src/commands.js";

const base = {
  version: "0.67.0",
  configPath: "/home/u/.pi/plus.yml",
  sessions: 9,
  nodes: 6,
  running: 9,
  off: 0,
  stopped: 0,
  unmanaged: 0,
  cronJobs: 2,
  cronLate: 0,
};

test("a quiet fleet says so, in three lines", () => {
  const summary = startSummary(base);
  assert.equal(summary.head, "pi-plus 0.67.0 · /home/u/.pi/plus.yml");
  assert.equal(summary.facts, "9/9 running · 6 machines · 2 cron jobs");
  assert.equal(summary.verdict, "nothing needs you right now");
});

test("each kind of trouble gets a word, without a paragraph", () => {
  assert.match(startSummary({ ...base, running: 7, off: 2 }).verdict, /^2 off — pp plan orders them$/);
  assert.match(startSummary({ ...base, running: 8, stopped: 1 }).verdict, /1 stopped by hand/);
  assert.match(startSummary({ ...base, unmanaged: 1 }).verdict, /1 unmanaged/);
  assert.match(startSummary({ ...base, cronLate: 1 }).verdict, /1 cron behind/);
  // several at once stay on one line
  const both = startSummary({ ...base, running: 6, off: 1, unmanaged: 2 }).verdict;
  assert.match(both, /1 off · 2 unmanaged/);
});

test("a machine with one session and no cron does not pluralise", () => {
  const summary = startSummary({ ...base, sessions: 1, running: 1, nodes: 1, cronJobs: 0 });
  assert.equal(summary.facts, "1/1 running · 1 machine");
});

test("with no config it points at the way to make one", () => {
  const summary = startSummary({ ...base, configPath: null, sessions: 0, running: 0, nodes: 0, cronJobs: 0 });
  assert.match(summary.head, /no config yet — pp new <name> --save$/);
  assert.equal(summary.facts, "0/0 running");
});
