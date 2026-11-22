import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
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

/**
 * Same as `shape`, but extra keys are allowed — for entries where `detail` and
 * `node` only appear when a command had something to say.
 */
function shapePart(value, contract, where) {
  shape(value, "object", where);
  for (const [key, sub] of Object.entries(contract)) {
    assert.ok(Object.prototype.hasOwnProperty.call(value, key), `${where}: missing ${key}`);
    shape(value[key], sub, `${where}.${key}`);
  }
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
      dangling: "array",
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
    // 1 is a legitimate exit code here: doctor exits 1 when a check fails, and a
    // CI runner has no tmux/pi/autostart. The contract under test is the shape.
    assert.ok([0, 1].includes(result.status), `doctor --json exited ${result.status}: ${result.stderr}`);
    assert.notEqual(result.text.trim(), "", `doctor --json printed nothing (stderr: ${result.stderr})`);
    const payload = JSON.parse(result.text);
    shape(payload, { checks: "array", failed: "array", warnings: "array" }, "doctor");
    for (const check of payload.checks) shape(check, { label: "string", ok: "boolean", detail: "string", fix: "string|null" }, `doctor.checks[${check.label}]`);
    // `failed` is *sorted by what unblocks the most*, so compare as a set: the
    // order is a design decision that differs from declaration order on a
    // machine where several checks fail (CI always is one)
    assert.deepEqual(
      payload.failed.slice().sort(),
      payload.checks.filter((check) => !check.ok).map((check) => check.label).sort(),
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
    for (const job of box.json(["cron", "ls"])) {
      shape(job, { id: "string", schedule: "string", next: "string", nextRun: "string|null", runs: "number", last: "string" }, "cron ls[]");
    }
    for (const node of box.json(["node", "ls"])) {
      shape(node, { name: "string", host: "string", port: "number", auth: "string", tags: "array" }, "node ls[]");
    }
    for (const entry of box.json(["audit"])) {
      shapePart(
        entry,
        { action: "string", target: "string", actor: "string", result: "string", ts: "string", node: "string|null", detail: "string|null" },
        "audit[]",
      );
    }
    for (const scenario of box.json(["runbook"])) {
      shape(scenario, { id: "string", title: "string", symptom: "string", means: "string", steps: "array", fix: "string" }, `runbook[${scenario.id}]`);
      for (const step of scenario.steps) shape(step, { do: "string", see: "string" }, `runbook[${scenario.id}].steps`);
    }
  } finally {
    box.stop();
  }
});

test("snapshot --json wraps the block and names its parts", () => {
  const box = sandbox();
  try {
    const payload = box.json(["snapshot"]);
    shape(payload, { version: "string", host: "string", time: "string", config: "string|null", text: "string", cron: "array", nodes: "array", todos: "array", audit: "array" }, "snapshot");
    for (const todo of payload.todos) shape(todo, { id: "string", session: "string|null", title: "string" }, "snapshot.todos[]");
    assert.match(payload.text, /9?\d*\/\d+ running|running/, "the block carries the session table");
    for (const job of payload.cron) shape(job, { id: "string", target: "string|null", schedule: "string", next: "string", runs: "number", last: "string" }, "snapshot.cron[]");
    for (const node of payload.nodes) shape(node, { name: "string", target: "string", tags: "array", drained: "boolean", guarded: "boolean", sessions: "number" }, "snapshot.nodes[]");
  } finally {
    box.stop();
  }
});

test("role --list --json and todo ls --json keep their shape", () => {
  const box = sandbox();
  try {
    const roles = box.json(["role", "--list"]);
    assert.ok(Array.isArray(roles), "role --list --json is an array, empty or not");
    for (const entry of roles) shape(entry, { role: "string", count: "number", sessions: "array" }, "role list[]");
    const todos = box.json(["todo", "ls"]);
    assert.ok(Array.isArray(todos), "todo ls --json is an array");
    for (const entry of todos) {
      shapePart(entry, { id: "string", session: "string", kind: "string", title: "string", state: "string" }, "todo ls[]");
    }
  } finally {
    box.stop();
  }
});

test("doctor prints its table even where tmux is missing — that is what it is for", () => {
  // reproduce the CI runner: node, and nothing else on PATH
  const box = sandbox();
  try {
    const bare = mkdtempSync(join(tmpdir(), "pp-bare-"));
    symlinkSync(process.execPath, join(bare, "node"));
    const result = spawnSync(process.execPath, [BIN, "-c", join(box.root, "plus.yml"), "doctor", "--json"], {
      encoding: "utf8",
      env: { ...process.env, PATH: bare, XDG_STATE_HOME: join(box.root, "bare-state") },
    });
    assert.ok([0, 1].includes(result.status), `exited ${result.status}: ${result.stderr}`);
    const payload = JSON.parse(result.stdout);
    const tmux = payload.checks.find((check) => check.label === "tmux");
    assert.equal(tmux.ok, false);
    assert.match(tmux.fix, /install tmux/);
    assert.ok(payload.failed.includes("tmux"));
  } finally {
    box.stop();
  }
});

test("cron dryrun --json: one entry per job, with the plan or the reason", () => {
  const box = sandbox();
  try {
    const added = box.pp(["cron", "add", "--session", "ja", "--every", "10m", "ping"]);
    const id = (added.text.match(/scheduled ([0-9a-f]+)/) ?? [])[1];
    assert.ok(id, `no job id in: ${added.text}${added.stderr}`);
    const payload = box.json(["cron", "dryrun", id]);
    shape(payload, "array", "cron.dryrun");
    const entry = payload[0];
    assert.ok("plan" in entry || "verdict" in entry, `neither plan nor verdict in ${JSON.stringify(entry)}`);
    if (entry.plan) shapePart(entry.plan, { targets: "array", note: "any" }, "cron.dryrun[0].plan");
  } finally {
    box.stop();
  }
});

test("why <job> --json: the schedule, the counts, and the reach", () => {
  const box = sandbox();
  try {
    const added = box.pp(["cron", "add", "--session", "ja", "--every", "10m", "ping"]);
    const id = (added.text.match(/scheduled ([0-9a-f]+)/) ?? [])[1];
    const payload = box.json(["why", id]);
    shape(payload, {
      id: "string",
      action: "string|null",
      target: "string|null",
      schedule: "object",
      catchUp: "number|null",
      idleAfter: "number|null",
      verdict: "string",
      tick: "boolean",
      nextRun: "string|null",
      lastRun: "string|null",
      lastAttempt: "string|null",
      lastStatus: "string|null",
      runs: "number",
      skipped: "number",
      busyTarget: "boolean",
      targetDetail: "string",
      wouldReach: "object|null",
    }, "why.job");
    if (payload.wouldReach) shape(payload.wouldReach, { send: "number", total: "number", note: "string|null" }, "why.job.wouldReach");
  } finally {
    box.stop();
  }
});

test("why --role --json: who carries the label, and which jobs aim at it", () => {
  const box = sandbox();
  try {
    const payload = box.json(["why", "--role", "pm"]);
    shape(payload, { role: "string", up: "number", total: "number", sessions: "array", cron: "array" }, "why.role");
    shape(payload.sessions[0], { name: "string", state: "string", node: "string|null", verdict: "string" }, "why.role.sessions[0]");
  } finally {
    box.stop();
  }
});
