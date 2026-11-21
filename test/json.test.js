import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * The `--json` surfaces are contracts: somebody's script parses them.
 *
 * These tests pin the *keys and their types*, never the values — a new key is a
 * deliberate edit here (and a release note), a missing one is a red build
 * instead of a script that breaks at 3am in someone else's on-call.
 */

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BIN = join(ROOT, "bin", "pp.js");

const TYPES = {
  string: (v) => typeof v === "string",
  number: (v) => typeof v === "number",
  boolean: (v) => typeof v === "boolean",
  object: (v) => v !== null && typeof v === "object" && !Array.isArray(v),
  array: (v) => Array.isArray(v),
  "string|null": (v) => v === null || typeof v === "string",
  "number|null": (v) => v === null || typeof v === "number",
  "object|null": (v) => v === null || (typeof v === "object" && !Array.isArray(v)),
  any: () => true,
};

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), "pp-json-"));
  const socket = `pp-json-${process.pid}`;
  const configPath = join(root, "plus.yml");
  writeFileSync(
    configPath,
    [
      "version: 1",
      "defaults:",
      '  restart: "no"',
      "sessions:",
      "  - name: ja",
      "    cwd: /tmp",
      "    agent: bash",
      "    role: pm",
      "  - name: jb",
      "    cwd: /tmp",
      "    agent: bash",
      "",
    ].join("\n"),
  );
  const env = { ...process.env, XDG_STATE_HOME: join(root, "state") };
  delete env.PP_AUDIT_FILE;
  delete env.TMUX;
  mkdirSync(env.XDG_STATE_HOME, { recursive: true });
  const pp = (args) => {
    const result = spawnSync(process.execPath, [BIN, "-c", configPath, "--socket", socket, ...args], { encoding: "utf8", env });
    return { status: result.status, text: result.stdout, stderr: result.stderr };
  };
  const json = (args) => {
    const result = pp([...args, "--json"]);
    assert.equal(result.status, 0, `${args.join(" ")} --json exited ${result.status}: ${result.stderr}`);
    return JSON.parse(result.text);
  };
  pp(["up"]);
  return { root, socket, pp, json, stop: () => spawnSync("tmux", ["-L", socket, "kill-server"], { encoding: "utf8" }) };
}

function shape(value, contract, where) {
  assert.equal(TYPES[contract] !== undefined || typeof contract === "object", true, `${where}: unknown contract ${contract}`);
  if (typeof contract === "string") {
    assert.ok(TYPES[contract](value), `${where}: expected ${contract}, got ${Array.isArray(value) ? "array" : typeof value}`);
    return;
  }
  shape(value, "object", where);
  assert.deepEqual(Object.keys(value).sort(), Object.keys(contract).sort(), `${where}: keys drifted`);
  for (const [key, sub] of Object.entries(contract)) shape(value[key], sub, `${where}.${key}`);
}

test("status --json: one row per session, plus the drift block", () => {
  const box = sandbox();
  try {
    const payload = box.json(["status"]);
    // counts where a number is the whole answer, lists where the names are the
    // point: `down` has `reasons` to explain itself, `stray` has to be named
    shape(payload, {
      sessions: "array",
      drift: { down: "number", unmanaged: "number", stray: "array", reasons: "array" },
    }, "status");
    shape(payload.sessions[0], {
      index: "number",
      name: "string",
      role: "string|null",
      node: "string",
      tmux: "string",
      todos: "number",
      state: "string",
      reason: "string",
      restart: "string",
      pid: "string",
      command: "string",
      cwd: "string",
      pi: "boolean",
      piSession: "string",
      piSessionName: "string",
      activity: "number",
      idleSeconds: "number|null",
      idle: "string",
      remotePiName: "string",
      cron: "string",
      cwdMissing: "boolean",
      lastStart: "object|null",
      restarts: "array",
      client: "string",
    }, "status.sessions[0]");
  } finally {
    box.stop();
  }
});

test("plan --json: ordered steps and the facts they came from", () => {
  const box = sandbox();
  try {
    const payload = box.json(["plan"]);
    shape(payload, { steps: "array", facts: "object" }, "plan");
    shape(payload.facts, {
      reach: "array",
      drift: "array",
      unmanaged: "array",
      stuck: "array",
      cron: "array",
      logs: "array",
      autostart: "object|null",
      extension: "object|null",
    }, "plan.facts");
    if (payload.steps.length) {
      shape(payload.steps[0], { priority: "number", title: "string", command: "string", why: "string" }, "plan.steps[0]");
    }
  } finally {
    box.stop();
  }
});

test("why --json: the same keys for a session, whether it runs or not", () => {
  const box = sandbox();
  try {
    for (const name of ["ja", "jb"]) {
      shape(box.json(["why", name]), {
        name: "string",
        tmux: "string",
        node: "string|null",
        role: "string|null",
        state: "string",
        verdict: "string",
        reason: "object",
        cwd: "string",
        agent: "array",
        restart: "string",
        lastStart: "object|null",
        restarts: "array",
        busy: "boolean",
        cron: "array",
        todos: "number",
      }, `why ${name}`);
    }
  } finally {
    box.stop();
  }
});

test("doctor --json: every check carries the command that fixes it", () => {
  const box = sandbox();
  try {
    const result = box.pp(["doctor", "--json"]);
    const payload = JSON.parse(result.text);
    shape(payload, { checks: "array", failed: "array", warnings: "array" }, "doctor");
    for (const check of payload.checks) shape(check, { label: "string", ok: "boolean", detail: "string", fix: "string|null" }, `doctor.checks[${check.label}]`);
    assert.deepEqual(
      payload.failed,
      payload.checks.filter((check) => !check.ok).map((check) => check.label),
      "failed must be the labels of the checks that are not ok",
    );
  } finally {
    box.stop();
  }
});

test("check/ls surfaces keep their shape, empty or not", () => {
  const box = sandbox();
  try {
    shape(box.json(["check"]), { ok: "boolean", problems: "array", notes: "array", config: "string" }, "check");
    assert.ok(Array.isArray(box.json(["cron", "ls"])));
    assert.ok(Array.isArray(box.json(["node", "ls"])));
    assert.ok(Array.isArray(box.json(["audit"])));
    for (const scenario of box.json(["runbook"])) {
      shape(scenario, { id: "string", title: "string", symptom: "string", means: "string", steps: "array", fix: "string" }, `runbook[${scenario.id}]`);
      for (const step of scenario.steps) shape(step, { do: "string", see: "string" }, `runbook[${scenario.id}].steps`);
    }
  } finally {
    box.stop();
  }
});
