import assert from "node:assert/strict";
import test from "node:test";
import { planSteps } from "../src/commands.js";

const empty = { reach: [], drift: [], unmanaged: [], stuck: [], cron: [], logs: [], autostart: null, extension: null };

test("a healthy machine has nothing to do", () => {
  assert.deepEqual(planSteps(empty), []);
  assert.deepEqual(planSteps({ ...empty, autostart: { enabled: true }, extension: { stale: false } }), []);
});

test("an unreachable machine outranks everything behind it", () => {
  const steps = planSteps({
    ...empty,
    reach: [{ name: "t114", how: "ssh" }],
    drift: [{ name: "t118", down: 2, drained: false }],
    logs: [{ label: "cron.log", size: "57.2 MB" }],
  });
  assert.equal(steps[0].command, "pp node test t114");
  assert.equal(steps.at(-1).command, "pp clean");
  assert.equal(steps.length, 3);
});

test("a drained machine with work waiting is its own step", () => {
  const steps = planSteps({ ...empty, drift: [{ name: "t114", down: 2, drained: true }] });
  assert.equal(steps.length, 1);
  assert.equal(steps[0].command, "pp node undrain t114");
  assert.match(steps[0].title, /2 session\(s\) waiting/);
  // nothing waiting, nothing to say
  assert.deepEqual(planSteps({ ...empty, drift: [{ name: "t114", down: 0, drained: true }] }), []);
});

test("off sessions collapse into one step, named per machine", () => {
  const steps = planSteps({
    ...empty,
    drift: [
      { name: "this machine", down: 1, drained: false },
      { name: "t118", down: 2, drained: false },
    ],
  });
  assert.equal(steps.length, 1);
  assert.equal(steps[0].command, "pp up --drift");
  assert.match(steps[0].title, /start 3 session\(s\)/);
  assert.match(steps[0].why, /this machine, t118/);
});

test("cron, adopt, stuck agents and logs keep their order", () => {
  const steps = planSteps({
    ...empty,
    cron: [{ id: "aaaaaa", late: "30m" }],
    drift: [{ name: "this machine", down: 1, drained: false }],
    unmanaged: ["stray-1", "x@t114"],
    stuck: [{ name: "api", quiet: 95 }],
    logs: [{ label: "info.log", size: "61.0 MB" }],
  });
  assert.deepEqual(
    steps.map((step) => step.command),
    ["pp cron run aaaaaa", "pp up --drift", "pp adopt", "pp logs api", "pp clean"],
  );
});

test("autostart and a stale extension are named with their commands", () => {
  const steps = planSteps({
    ...empty,
    autostart: { enabled: false },
    extension: { stale: true, want: "0.64.0", command: "npm install --prefix /home/user/.pi/agent/npm pi-farm@0.64.0" },
  });
  assert.deepEqual(
    steps.map((step) => step.command),
    ["pp install", "npm install --prefix /home/user/.pi/agent/npm pi-farm@0.64.0"],
  );
});

test("a machine-scoped plan answers a narrower question", async () => {
  // --node asks "what do I type to make that machine take work again", so the
  // local-only facts (autostart, extension, this machine's logs) are not steps
  const scoped = planSteps({
    reach: [],
    drift: [{ name: "t114", down: 2, drained: false }],
    unmanaged: ["stray-a@t114", "stray-b@t114"],
    stuck: [],
    cron: [],
    logs: [],
    // planFacts leaves these null when scoped to a machine: they are this
    // machine's business, not that machine's
    autostart: null,
    extension: null,
  }).map((step) => step.command);
  assert.deepEqual(scoped, ["pp up --node t114", "pp adopt --node t114"]);
});

test("a machine without tmux says so instead of 'ssh failed'", () => {
  const [step] = planSteps({ reach: [{ name: "p202", how: "tmux-missing" }] });
  assert.equal(step.command, "apt install tmux (on p202)");
  assert.equal(step.priority, 0);
});

test("an unknown machine points at the list", () => {
  const [step] = planSteps({ reach: [{ name: "nope", how: "unknown" }] });
  assert.equal(step.command, "pp node ls");
});

test("a question waiting for an answer is a step, oldest first", () => {
  const steps = planSteps({
    waiting: [
      { id: "aaa111", session: "api", title: "ship it?", age: "2d ago" },
      { id: "bbb222", session: "web", title: "which branch?", age: "3h ago" },
    ],
  });
  assert.equal(steps.length, 1);
  assert.equal(steps[0].command, "pp todo ls");
  assert.equal(steps[0].priority, 8);
  assert.match(steps[0].title, /2 question\(s\) are waiting for an answer — oldest 2d ago/);
});

test("logs come after the questions, not before", () => {
  const steps = planSteps({
    waiting: [{ id: "aaa111", session: "api", title: "x", age: "2d ago" }],
    logs: [{ label: "info.log", size: "57.2 MB" }],
  });
  assert.deepEqual(steps.map((step) => step.command), ["pp todo ls", "pp clean"]);
});

test("a nearly full disk comes before the smaller fixes", () => {
  const steps = planSteps({
    disk: { bytes: 200 * 1024 * 1024, floor: 1024 * 1024 * 1024, free: "200.0 MB", want: "1.0 GB", mount: "/home/user/.local/state/pi-plus" },
    logs: [{ label: "cron.log", size: "60.0 MB" }],
  });
  assert.equal(steps[0].command, "pp clean");
  assert.match(steps[0].title, /200\.0 MB free — below the 1\.0 GB floor/);
  assert.ok(steps.length >= 2, "the log step is still there, just not first");
});

test("plenty of space adds nothing", () => {
  const steps = planSteps({ disk: null });
  assert.equal(steps.length, 0);
});
