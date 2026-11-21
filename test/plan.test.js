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
