import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SAFE_TMUX_NAME, diffLines, saveNewSession, tmuxSafeName } from "../src/commands.js";
import { loadConfig } from "../src/config.js";

const session = {
  name: "api",
  cwd: "/tmp/api",
  log: "/tmp/api/logs/api.log",
  remotePiName: "api",
};

function fakeUi() {
  const seen = [];
  return { seen, info: (m) => seen.push(m), error: (m) => seen.push(`ERR ${m}`) };
}

test("tmuxSafeName keeps usable names and repairs the rest", () => {
  assert.equal(tmuxSafeName("mango-release-01"), "mango-release-01");
  assert.equal(tmuxSafeName("My Project"), "My-Project");
  assert.equal(tmuxSafeName("数据/farm.v2"), "farm-v2");
  assert.equal(tmuxSafeName("--edge--"), "edge");
  assert.equal(tmuxSafeName("///"), "session");
  assert.ok(SAFE_TMUX_NAME.test(tmuxSafeName("数据/farm.v2")));
});

test("saveNewSession creates a usable config file", () => {
  const dir = mkdtempSync(join(tmpdir(), "pp-new-"));
  const path = join(dir, "nested", "plus.yml");
  const ui = fakeUi();
  saveNewSession(path, session, ui);

  const config = loadConfig({ configPath: path, cwd: dir });
  assert.equal(config.sessions.length, 1);
  assert.equal(config.sessions[0].name, "api");
  assert.equal(config.sessions[0].cwd, "/tmp/api");
  assert.equal(config.sessions[0].log, "/tmp/api/logs/api.log");
  assert.equal(config.sessions[0].remotePiName, "api");
  assert.equal(config.sessions[0].remotePiMode, "env");
  assert.equal(config.sessions[0].restart, "always");
  assert.deepEqual(config.warnings, []);
  assert.match(ui.seen.join("\n"), /saved to /);
});

test("saveNewSession appends and honours --no-remote-pi", () => {
  const dir = mkdtempSync(join(tmpdir(), "pp-new-"));
  const path = join(dir, "plus.yml");
  writeFileSync(path, "version: 1\nsessions:\n  - name: old\n    cwd: /tmp\n", "utf8");

  saveNewSession(path, { name: "bare", cwd: "/tmp/bare" }, fakeUi());
  const text = readFileSync(path, "utf8");
  assert.match(text, /- name: old/);
  assert.match(text, /- name: bare/);
  assert.match(text, /remote_pi_name: false/);

  const config = loadConfig({ configPath: path, cwd: dir });
  assert.deepEqual(
    config.sessions.map((s) => [s.name, s.remotePiName, s.remotePiMode]),
    [
      // defaults: name = session name, mode = config; `remote_pi_name: false` disables it
      ["old", "old", "config"],
      ["bare", null, "config"],
    ],
  );
});

test("saveNewSession refuses a config without a sessions section", () => {
  const dir = mkdtempSync(join(tmpdir(), "pp-new-"));
  const path = join(dir, "plus.yml");
  writeFileSync(path, "version: 1\n", "utf8");
  const ui = fakeUi();
  saveNewSession(path, session, ui);
  assert.equal(readFileSync(path, "utf8"), "version: 1\n");
  assert.match(ui.seen.join("\n"), /has no "sessions:" section/);
});

test("diffLines prints only what a pane printed since the last read", () => {
  const prompt = "me@box:~$";
  assert.deepEqual(diffLines(`a\n${prompt}`, `a\n${prompt}`), [], "an unchanged pane prints nothing");
  assert.deepEqual(diffLines(`keep\n${prompt}`, `keep\nrun\ndone\n${prompt}`), ["run", "done", prompt]);
  // a prompt line that repeats at the bottom must not hide the line above it
  assert.deepEqual(diffLines(`one\n${prompt}`, `one\ntwo\n${prompt}`), ["two", prompt]);
  assert.deepEqual(diffLines(`${prompt}`, `tail\n${prompt}`), ["tail", prompt]);
  assert.deepEqual(diffLines("git status\nWork 12%", "git status\nWork 37%"), ["Work 37%"], "a bare progress line still counts");
});
