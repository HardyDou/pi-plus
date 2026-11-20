import assert from "node:assert/strict";
import test from "node:test";

import { fleetProblems, formatSweepLine } from "../src/commands.js";

test("a sweep line names the problems and the command that fixes each", () => {
  const line = formatSweepLine(
    [
      { kind: "off", name: "risk-02", text: "off: risk-02 (pp up risk-02)" },
      { kind: "stuck", name: "mango-release-01", text: "stuck: mango-release-01 busy 95m (pp logs mango-release-01)" },
    ],
    { id: "6c5516" },
  );
  assert.equal(
    line,
    "fleet health (pp cron 6c5516): 2 problems — off: risk-02 (pp up risk-02); " +
      "stuck: mango-release-01 busy 95m (pp logs mango-release-01)",
  );
  assert.equal(
    formatSweepLine([{ text: "off: a (pp up a)" }], { id: "x" }),
    "fleet health (pp cron x): 1 problem — off: a (pp up a)",
    "singular reads as one problem, not one problems",
  );
});

test("a long list is capped so the message never trips the paste marker", () => {
  const many = Array.from({ length: 9 }, (_, i) => ({ kind: "off", name: `s${i}`, text: `off: s${i} (pp up s${i})` }));
  const line = formatSweepLine(many, { id: "abc123", most: 4 });
  assert.match(line, /^fleet health \(pp cron abc123\): 9 problems — /);
  assert.match(line, /and 5 more \(pp status\)$/);
  assert.ok(line.length < 400, `the line must stay short, got ${line.length}`);
});

test("no config and no tmux are reported, not silently healthy", () => {
  assert.deepEqual(fleetProblems(null, {}), []);
  const problems = fleetProblems(
    { sessions: [{ name: "a", tmuxName: "a", node: null, restart: "always" }], path: "/nope.yml", nodes: [] },
    { socket: "definitely-not-running" },
  );
  assert.equal(problems.length, 1);
  assert.equal(problems[0].kind, "tmux");
  assert.match(problems[0].text, /tmux is not (answering|running here)/);
});
