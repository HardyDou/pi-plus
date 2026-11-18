import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { clearStopped, isStopped, markStopped, statePath, stoppedSessions } from "../src/state.js";

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
