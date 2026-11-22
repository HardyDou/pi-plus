import assert from "node:assert/strict";
import test from "node:test";
import { waitTillIdle } from "../src/commands.js";

/** A tmux stand-in: a scripted list of busy flags, one per poll. */
function fake({ busy = [], exists = true, screen = "the reply" } = {}) {
  const flags = [...busy];
  const state = { polls: 0, sleeps: 0, captured: 0, running: exists };
  return {
    state,
    sessionExists() {
      return state.running;
    },
    isAgentBusy() {
      state.polls++;
      const next = flags.length > 1 ? flags.shift() : flags[0];
      return next ?? false;
    },
    capture() {
      state.captured++;
      return screen;
    },
    kill() {
      state.running = false;
    },
  };
}

const noSleep = () => {};

test("waitTillIdle returns as soon as the agent is idle", () => {
  const tmux = fake({ busy: [false] });
  const result = waitTillIdle(tmux, "api", { sleep: noSleep });
  assert.deepEqual(result, { ok: true, reason: "idle", text: "the reply" });
  assert.equal(tmux.state.polls, 1);
  assert.equal(tmux.state.captured, 1);
});

test("waitTillIdle keeps polling while the agent works", () => {
  const tmux = fake({ busy: [true, true, false] });
  const result = waitTillIdle(tmux, "api", { sleep: noSleep });
  assert.equal(result.ok, true);
  assert.equal(tmux.state.polls, 3);
});

test("waitTillIdle gives up at the deadline and says so", () => {
  const tmux = fake({ busy: [true] });
  let clock = 0;
  const result = waitTillIdle(tmux, "api", {
    limit: 5,
    sleep: () => {
      clock += 1000;
    },
    now: () => clock,
  });
  assert.deepEqual(result, { ok: false, reason: "timeout", text: null });
  assert.ok(clock <= 5000, `stopped at ${clock}ms, not past the 5s limit`);
});

test("waitTillIdle reports a session that died mid-turn", () => {
  const tmux = fake({ busy: [true, true] });
  let clock = 0;
  const result = waitTillIdle(tmux, "api", {
    limit: 30,
    sleep: () => {
      clock += 1000;
      if (clock === 2000) tmux.kill();
    },
    now: () => clock,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "exited");
});

test("trimPane drops the input box, the echo of what we sent, and blank tails", async () => {
  const { trimPane } = await import("../src/commands.js");
  const rule = "─".repeat(60);
  const screen = [
    "earlier transcript line",
    "reply with exactly: pong",
    "",
    "pong",
    "",
    rule,
    "the input box",
    rule,
    "/data/scratch  ↑1k ↓2k  $0.001",
    "",
  ].join("\n");
  const kept = trimPane(screen, "reply with exactly: pong");
  assert.deepEqual(kept, ["earlier transcript line", "", "pong"]);
});

test("trimPane keeps the last N lines when asked", async () => {
  const { trimPane } = await import("../src/commands.js");
  const screen = ["a", "b", "c", "d", "e"].join("\n");
  assert.deepEqual(trimPane(screen, "ignored", 2), ["d", "e"]);
});
