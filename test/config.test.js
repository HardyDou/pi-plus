import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildSessionArgv,
  normalizeConfig,
  removeSessionBlock,
  resolveSessionRef,
  sanitizeRemotePiName,
  setSessionField,
  splitCommand,
  appendSessionBlock,
  renderSessionEntry,
  renameSessionInFile,
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

test("removeSessionBlock cuts one entry and leaves the rest of the file alone", () => {
  const raw = `version: 1
defaults:
  agent: pi
sessions:
  - name: backend
    cwd: /tmp/backend
  # this note belongs to nobody in particular
  - name: docs
    cwd: /tmp/docs
    log: ~/.pi/plus/logs/docs.log
  - name: ops
    cwd: /tmp/ops
`;
  const { text, removed } = removeSessionBlock(raw, "docs");
  assert.equal(removed, true);
  assert.doesNotMatch(text, /docs/);
  assert.match(text, /# this note belongs to nobody in particular/);
  assert.match(text, /- name: backend/);
  assert.match(text, /- name: ops/);
  // what is left still parses, and keeps the entries that should survive
  const cfg = normalizeConfig(parseYaml(text), { configPath: "trimmed" });
  assert.deepEqual(cfg.sessions.map((s) => s.name), ["backend", "ops"]);

  // cutting the first and the last entry works too
  assert.deepEqual(
    normalizeConfig(parseYaml(removeSessionBlock(raw, "backend").text), { configPath: "x" }).sessions.map((s) => s.name),
    ["docs", "ops"],
  );
  assert.deepEqual(
    normalizeConfig(parseYaml(removeSessionBlock(raw, "ops").text), { configPath: "x" }).sessions.map((s) => s.name),
    ["backend", "docs"],
  );
});

test("removeSessionBlock reports a miss instead of rewriting the file", () => {
  const raw = "version: 1\nsessions:\n  - name: only\n    cwd: /tmp\n";
  const { text, removed } = removeSessionBlock(raw, "ghost");
  assert.equal(removed, false);
  assert.equal(text, raw);
});

test("setSessionField edits one line of one session and nothing else", () => {
  const text = `version: 1
sessions:
  - name: api
    cwd: /srv/api
  - name: web
    cwd: /srv/web
`;
  const added = setSessionField(text, "api", "node", "prod-01");
  assert.match(added, /- name: api\n {4}node: prod-01\n {4}cwd: \/srv\/api/);
  assert.match(added, /- name: web\n {4}cwd: \/srv\/web/, "the other session is untouched");

  const updated = setSessionField(added, "api", "node", "prod-02");
  assert.equal(updated.match(/node:/g).length, 1, "updating replaces, it does not add");
  assert.match(updated, /node: prod-02/);

  const removed = setSessionField(updated, "api", "node", null);
  assert.doesNotMatch(removed, /node:/);
  assert.match(removed, /- name: api\n {4}cwd: \/srv\/api/);

  assert.equal(setSessionField(text, "nope", "node", "x"), null);
  assert.equal(setSessionField(text, "api", "node", "prod-01").split("\n").length, text.split("\n").length + 1);
});

test("an adopted session is appended after the last one, not at the end of the file", () => {
  const text = `version: 1
sessions:
  - name: api
    cwd: /srv/api
nodes:
  - name: far
    host: h
`;
  const entry = renderSessionEntry({ name: "stray", cwd: "/tmp", node: "far", agent: "pi", restart: "no" });
  const next = appendSessionBlock(text, entry);
  assert.match(next, /- name: api[\s\S]*- name: stray/);
  assert.ok(next.indexOf("- name: stray") < next.indexOf("nodes:"), "lands inside sessions, not after nodes");
  assert.match(next, /restart: "no"/, "restart: no must be quoted or YAML reads a boolean");

  // a cloned session carries its template: role, env and args must survive the
  // round trip, or `pp new --from` silently loses half of what it copied
  const clone = renderSessionEntry({
    name: "risk-02",
    cwd: "/srv/risk",
    role: "risk",
    agent: "pi",
    restart: "unless-stopped",
    env: { HTTP_PROXY: "http://127.0.0.1:7890", PORT: "8080" },
    args: ["--model", "deepseek"],
  });
  assert.match(clone, /^    role: risk$/m);
  assert.match(clone, /^    env:\n      HTTP_PROXY: http:\/\/127\.0\.0\.1:7890$/m);
  assert.match(clone, /^      PORT: "8080"$/m); // digits stay strings
  assert.match(clone, /^    args: \["--model", deepseek\]$/m);

  const empty = appendSessionBlock("version: 1\nsessions: []\n", renderSessionEntry({ name: "x", cwd: "/tmp" }));
  assert.match(empty, /sessions:\n {2}- name: x/);
  assert.equal(appendSessionBlock("version: 1\n", renderSessionEntry({ name: "x", cwd: "/tmp" })), null);
});

test("removing the last session leaves a list, not a null section", () => {
  const text = "version: 1\nsessions:\n  - name: only\n    cwd: /tmp\n";
  const result = removeSessionBlock(text, "only");
  assert.equal(result.removed, true);
  assert.match(result.text, /^sessions: \[\]$/m);
  // and the neighbours survive: the old bug here cut the file at the next section
  const two = "sessions:\n  - name: a\n    cwd: /tmp\nnodes:\n  - name: n\n    host: h\n";
  const after = removeSessionBlock(two, "a");
  assert.match(after.text, /sessions: \[\]/);
  assert.match(after.text, /nodes:/);
  assert.match(after.text, /host: h/);
});

test("a config can ask for name ordering, and roles are labels", () => {
  const cfg = normalizeConfig(
    parseYaml(
      [
        "sort: name",
        "sessions:",
        "  - name: risk-10",
        "    cwd: /tmp",
        "  - name: risk-2",
        "    cwd: /tmp",
        "    role: pm",
      ].join("\n"),
    ),
    { configPath: "t.yml" },
  );
  assert.equal(cfg.sort, "name");
  assert.deepEqual(
    cfg.sessions.map((session) => [session.name, session.role]),
    [
      ["risk-10", null],
      ["risk-2", "pm"],
    ],
  );
});

test("a bad sort key or role is refused with the reason", () => {
  assert.throws(
    () => normalizeConfig(parseYaml("sort: sideways\nsessions: []\n"), { configPath: "t.yml" }),
    /sort "sideways" must be one of config, idle, name, role/,
  );
  assert.throws(
    () => normalizeConfig(parseYaml("sessions:\n  - name: a\n    cwd: /tmp\n    role: '!!'\n"), { configPath: "t.yml" }),
    /role "!!" must be a short label/,
  );
});

test("renameSessionInFile moves the name and the copies of it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pp-rename-"));
  const file = join(dir, "plus.yml");
  writeFileSync(
    file,
    [
      "version: 1",
      "sessions:",
      "  - name: api",
      "    cwd: /srv/api",
      "    tmux_name: api",
      "    pi_session_name: api",
      "    pi_session: 01a1e833-6bdc-7139-abc2-bdb6706d849d",
      "  - name: api-old",
      "    cwd: /tmp",
      "",
    ].join("\n"),
  );
  assert.deepEqual(renameSessionInFile(file, "api", "api-v2"), { changed: 3 });
  const text = readFileSync(file, "utf8");
  assert.match(text, /- name: api-v2/);
  assert.match(text, /tmux_name: api-v2/);
  assert.match(text, /pi_session_name: api-v2/);
  // the conversation is not renamed: it is keyed by id, not by name
  assert.match(text, /pi_session: 01a1e833-6bdc-7139-abc2-bdb6706d849d/);
  // a neighbour whose name merely starts with it is untouched
  assert.match(text, /- name: api-old/);
  assert.equal(renameSessionInFile(file, "nope", "x"), null);
});
