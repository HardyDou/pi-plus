import assert from "node:assert/strict";
import test from "node:test";
import { deliveryPlan } from "../src/commands.js";

const now = Date.now();
const ago = (s) => Math.floor(now / 1000) - s;

function fakeTmux({ live = {}, busy = [] } = {}) {
  return {
    listSessions: () => new Map(Object.entries(live).map(([name, activity]) => [name, { activity }])),
    isAgentBusy: (name) => busy.includes(name),
  };
}

test("deliveryPlan says who a broadcast would reach right now", () => {
  const tmux = fakeTmux({ live: { quiet: ago(900), chatty: ago(2), working: ago(900) }, busy: ["working"] });
  const plan = deliveryPlan(tmux, { session: "*", idleAfter: 300 });
  const verdicts = Object.fromEntries(plan.targets.map((entry) => [entry.name, entry.verdict]));
  assert.deepEqual(verdicts, { chatty: "lately", quiet: "send", working: "busy" });
});

test("deliveryPlan reports a named session that is gone instead of pretending", () => {
  const plan = deliveryPlan(fakeTmux({ live: {} }), { session: "ghost", idleAfter: 0 });
  assert.deepEqual(plan.targets, [{ name: "ghost", verdict: "down" }]);
});

test("deliveryPlan leaves a drained machine out of the picture", () => {
  const tmux = fakeTmux({ live: { remote: ago(900) } });
  const config = { sessions: [], nodes: [], tmuxSocket: null };
  const plan = deliveryPlan(tmux, { session: "*" }, { config });
  assert.equal(plan.targets[0].verdict, "send", "no nodes configured means nothing is drained");
});

test("deliveryPlan says when tmux is not answering", () => {
  const plan = deliveryPlan({ listSessions: () => { throw new Error("no server"); } }, { session: "*" });
  assert.deepEqual(plan.targets, []);
  assert.match(plan.note, /not answering/);
});

test("the same plan backs the 'now' line of pp why <job>", () => {
  // one session that just printed, one that has been quiet: the job would reach 1 of 2
  const tmux = fakeTmux({ live: { quiet: ago(900), chatty: ago(1) } });
  const plan = deliveryPlan(tmux, { session: "*", idleAfter: 300 });
  const send = plan.targets.filter((entry) => entry.verdict === "send").length;
  assert.equal(send, 1);
  assert.equal(plan.targets.length, 2);
});
