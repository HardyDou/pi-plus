import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  busySinceOf,
  clearBusy,
  clearStopped,
  isStopped,
  markBusy,
  markStopped,
  markStarted,
  startedOf,
  statePath,
  stoppedSessions,
} from "../src/state.js";

const envWith = () => ({ HOME: mkdtempSync(join(tmpdir(), "pi-plus-state-")) });

test("manual stops are recorded per config and session", () => {
  const env = envWith();
  assert.equal(isStopped("/cfg/a.yml", "backend", env), false);
  markStopped("/cfg/a.yml", "backend", env);
  assert.equal(isStopped("/cfg/a.yml", "backend", env), true);
  assert.equal(isStopped("/cfg/a.yml", "docs", env), false);
  assert.equal(isStopped("/cfg/b.yml", "backend", env), false);
  assert.deepEqual(
    stoppedSessions("/cfg/a.yml", env).map((s) => s.name),
    ["backend"],
  );

  clearStopped("/cfg/a.yml", "backend", env);
  assert.equal(isStopped("/cfg/a.yml", "backend", env), false);
});

test("state file lives under XDG_STATE_HOME and survives corrupt data", () => {
  const env = envWith();
  assert.equal(statePath(env), join(env.HOME, ".local", "state", "pi-plus", "state.json"));
  markStopped("/cfg/a.yml", "backend", env);
  const raw = JSON.parse(readFileSync(statePath(env), "utf8"));
  assert.equal(raw["/cfg/a.yml"].backend.stopped, true);

  const xdg = { ...env, XDG_STATE_HOME: join(env.HOME, "xdg") };
  assert.equal(statePath(xdg), join(env.HOME, "xdg", "pi-plus", "state.json"));
  assert.equal(isStopped("/cfg/a.yml", "backend", xdg), false);
});

test("busy clocks and manual stops share one entry without eating each other", () => {
  const env = envWith();
  const cfg = "/cfg/a.yml";
  assert.equal(busySinceOf(cfg, "api", env), null);

  const at = markBusy(cfg, "api", env);
  assert.equal(busySinceOf(cfg, "api", env), at);

  // stopping a session must not forget how long its agent has been busy
  markStopped(cfg, "api", env);
  assert.equal(isStopped(cfg, "api", env), true);
  assert.equal(busySinceOf(cfg, "api", env), at, "markStopped merges instead of replacing");

  // and starting it again must not forget either
  clearStopped(cfg, "api", env);
  assert.equal(isStopped(cfg, "api", env), false);
  assert.equal(busySinceOf(cfg, "api", env), at, "clearStopped only removes the stop fields");

  // when the agent goes quiet the clock goes away
  assert.equal(clearBusy(cfg, "api", env), true);
  assert.equal(busySinceOf(cfg, "api", env), null);
  assert.equal(clearBusy(cfg, "api", env), false, "clearing twice is not an error");
});

test("the last start records why and who, and keeps the other fields", () => {
  const env = envWith();
  const cfg = "/tmp/plus.yml";
  markStopped(cfg, "api", env);
  const started = markStarted(cfg, "api", { why: "heal", by: "ops@box#7" }, env);
  assert.equal(started.why, "heal");
  assert.equal(started.by, "ops@box#7");
  assert.match(started.at, /^\d{4}-\d{2}-\d{2}T/);
  // starting does not forget that somebody had stopped it, and vice versa
  assert.equal(isStopped(cfg, "api", env), true);
  assert.deepEqual(startedOf(cfg, "api", env), started);
  // a later start wins over the earlier one
  markStarted(cfg, "api", { why: "restart", by: "me@here#9" }, env);
  assert.equal(startedOf(cfg, "api", env).why, "restart");
  // unknown sessions stay null instead of throwing
  assert.equal(startedOf(cfg, "nope", env), null);
});
