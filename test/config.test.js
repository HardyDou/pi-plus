import assert from "node:assert/strict";
import test from "node:test";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  buildSessionArgv,
  normalizeConfig,
  resolveSessionRef,
  sanitizeRemotePiName,
  splitCommand,
} from "../src/config.js";
import { parseYaml } from "../src/yaml.js";

const base = (sessions, defaults = {}) => normalizeConfig({ defaults, sessions }, { configPath: "test.yml" });

test("one name drives tmux, pi and remote-pi by default", () => {
  const cfg = base([{ name: "backend", cwd: "/tmp" }]);
  const s = cfg.sessions[0];
  assert.equal(s.tmuxName, "backend");
  assert.equal(s.piSessionName, "backend");
  assert.equal(s.remotePiName, "backend");
  assert.equal(s.pi, true);
  assert.deepEqual(buildSessionArgv(s), ["pi", "--name", "backend"]);
});

test("names can be overridden independently", () => {
  const cfg = base([
    {
      name: "backend",
      cwd: "/tmp",
      tmux_name: "be",
      pi_session_name: "backend-pi",
      remote_pi_name: "backend mesh",
    },
  ]);
  const s = cfg.sessions[0];
  assert.equal(s.tmuxName, "be");
  assert.equal(s.piSessionName, "backend-pi");
  assert.equal(s.remotePiName, "backend-mesh");
  assert.deepEqual(buildSessionArgv(s), ["pi", "--name", "backend-pi"]);
});

test("pi_session becomes --session-id, paths become --session", () => {
  const cfg = base([
    { name: "a", cwd: "/tmp", pi_session: "1a2b3c4d" },
    { name: "b", cwd: "/tmp", pi_session: "~/sessions/x.jsonl" },
  ]);
  assert.deepEqual(buildSessionArgv(cfg.sessions[0]), ["pi", "--name", "a", "--session-id", "1a2b3c4d"]);
  assert.deepEqual(buildSessionArgv(cfg.sessions[1]), [
    "pi",
    "--name",
    "b",
    "--session",
    join(homedir(), "sessions", "x.jsonl"),
  ]);
});

test("pi integration is skipped for non-pi agents and can be disabled", () => {
  const cfg = base([
    { name: "shell", cwd: "/tmp", agent: "bash" },
    { name: "nopi", cwd: "/tmp", pi: false, pi_session: "abcd1234" },
  ]);
  assert.deepEqual(buildSessionArgv(cfg.sessions[0]), ["bash"]);
  assert.deepEqual(buildSessionArgv(cfg.sessions[1]), ["pi"]);
});

test("agent command strings are tokenized without a shell", () => {
  assert.deepEqual(splitCommand(`pi --model "sonnet:high" 'a b'`), ["pi", "--model", "sonnet:high", "a b"]);
  const cfg = base([{ name: "x", cwd: "/tmp", agent: "pi --verbose", args: ["--approve"] }]);
  assert.deepEqual(buildSessionArgv(cfg.sessions[0]), ["pi", "--verbose", "--name", "x", "--approve"]);
});

test("defaults merge into sessions and env is merged, not shared", () => {
  const cfg = base(
    [
      { name: "a", cwd: "/tmp", env: { A: "1" } },
      { name: "b", cwd: "/tmp" },
    ],
    { agent: "pi", args: ["--approve"], env: { TZ: "Asia/Shanghai" } },
  );
  assert.deepEqual(cfg.sessions[0].env, { TZ: "Asia/Shanghai", A: "1" });
  assert.deepEqual(cfg.sessions[1].env, { TZ: "Asia/Shanghai" });
  assert.deepEqual(cfg.sessions[0].args, ["--approve"]);
  assert.notEqual(cfg.sessions[0].env, cfg.sessions[1].env);
});

test("remote_pi_name false / null disables the rename", () => {
  const cfg = base([
    { name: "a", cwd: "/tmp", remote_pi_name: false },
    { name: "b", cwd: "/tmp", remote_pi_name: null },
  ]);
  assert.equal(cfg.sessions[0].remotePiName, null);
  assert.equal(cfg.sessions[1].remotePiName, null);
});

test("remote-pi names are sanitized", () => {
  assert.equal(sanitizeRemotePiName("  my/agent name  "), "my-agent-name");
  assert.equal(sanitizeRemotePiName("broadcast"), null);
  assert.equal(sanitizeRemotePiName(""), null);
});

test("restart policy defaults to always and accepts compose-style values", () => {
  const cfg = base([
    { name: "a", cwd: "/tmp" },
    { name: "b", cwd: "/tmp", restart: "no" },
    { name: "c", cwd: "/tmp", restart: "unless-stopped" },
    { name: "d", cwd: "/tmp", restart: "on-failure" },
    { name: "e", cwd: "/tmp", restart: false },
    { name: "f", cwd: "/tmp", restart: true },
  ]);
  assert.deepEqual(
    cfg.sessions.map((s) => s.restart),
    ["always", "no", "unless-stopped", "on-failure", "no", "always"],
  );
  assert.throws(() => base([{ name: "x", cwd: "/tmp", restart: "sometimes" }]), /restart must be one of/);

  // restart: no keeps the crashed pane around so it can be inspected.
  assert.equal(cfg.sessions[1].remainOnExit, true);
  assert.equal(cfg.sessions[0].remainOnExit, false);
});

test("rejects unsafe or duplicate tmux names", () => {
  assert.throws(() => base([{ name: "a.b", cwd: "/tmp" }]), /tmux-safe/);
  assert.throws(() => base([{ name: "x", cwd: "/tmp" }, { name: "y", cwd: "/tmp", tmux_name: "x" }]), /duplicate/);
});

test("rejects invalid pi session ids", () => {
  assert.throws(() => base([{ name: "a", cwd: "/tmp", pi_session: "-bad" }]), /not a valid pi session id/);
});

test("warns when one cwd is used with different remote-pi names", () => {
  const cfg = base([
    { name: "a", cwd: "/tmp", remote_pi_name: "one" },
    { name: "b", cwd: "/tmp", remote_pi_name: "two" },
  ]);
  assert.equal(cfg.warnings.length, 1);
  assert.match(cfg.warnings[0], /share cwd/);
  assert.match(cfg.warnings[0], /remote_pi_mode: env/);
});

test("env mode silences the shared-cwd remote-pi warning", () => {
  const cfg = base([
    { name: "a", cwd: "/tmp", remote_pi_name: "one", remote_pi_mode: "env" },
    { name: "b", cwd: "/tmp", remote_pi_name: "two", remote_pi_mode: "env" },
  ]);
  assert.deepEqual(cfg.warnings, []);
});

test("resolveSessionRef accepts names, tmux names and 1-based indices", () => {
  const cfg = base([
    { name: "one", cwd: "/tmp" },
    { name: "two", cwd: "/tmp", tmux_name: "tmux-two" },
    { name: "3", cwd: "/tmp" },
  ]);
  assert.equal(resolveSessionRef(cfg, "one").name, "one");
  assert.equal(resolveSessionRef(cfg, "tmux-two").name, "two");
  assert.equal(resolveSessionRef(cfg, "1").name, "one");
  assert.equal(resolveSessionRef(cfg, 2).name, "two");
  // an exact name wins over the index
  assert.equal(resolveSessionRef(cfg, "3").name, "3");
  assert.equal(resolveSessionRef(cfg, "4"), null);
  assert.equal(resolveSessionRef(cfg, "0"), null);
  assert.equal(resolveSessionRef(cfg, "nope"), null);
});

test("unknown keys are warnings, not errors", () => {
  const cfg = base([{ name: "a", cwd: "/tmp", nonsense: true }]);
  assert.match(cfg.warnings.join("\n"), /unknown key "nonsense"/);
});

test("example config parses", () => {
  const raw = parseYaml(`version: 1
defaults:
  agent: pi
sessions:
  - name: backend
    cwd: /tmp
  - name: docs
    cwd: /tmp
    pi_session: 1a2b3c4d
    remote_pi_name: docs
`);
  const cfg = normalizeConfig(raw, { configPath: "example" });
  assert.equal(cfg.sessions.length, 2);
  assert.equal(cfg.sessions[1].piSession, "1a2b3c4d");
});

test("push block is parsed and validated", () => {
  const raw = parseYaml(`version: 1
push:
  target: hardy@1.2.3.4#delta
  session: risk-01
  dir: ~/.drops
  port: 2222
sessions:
  - name: a
    cwd: /tmp
`);
  const cfg = normalizeConfig(raw, { configPath: "push.yml" });
  assert.deepEqual(cfg.push, {
    target: "hardy@1.2.3.4#delta",
    session: "risk-01",
    dir: "~/.drops",
    port: 2222,
  });
  assert.deepEqual(cfg.warnings, []);

  const bare = normalizeConfig(parseYaml("version: 1\nsessions:\n  - name: a\n    cwd: /tmp\n"), { configPath: "none" });
  assert.deepEqual(bare.push, { target: null, session: null, dir: null, port: null });

  assert.throws(
    () => normalizeConfig(parseYaml("version: 1\npush:\n  port: 99999\nsessions: []\n"), { configPath: "bad" }),
    /push\.port must be a port number/,
  );
  const unknown = normalizeConfig(parseYaml("version: 1\npush:\n  tk: x\nsessions: []\n"), { configPath: "u" });
  assert.match(unknown.warnings.join("\n"), /unknown push key "tk"/);
});
