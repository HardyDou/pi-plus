import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { describeStateFiles, inspectStateFiles, quarantineStateFile } from "../src/selfcheck.js";

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), "pp-selfcheck-"));
  const state = join(root, "pi-plus");
  mkdirSync(state, { recursive: true });
  // PP_AUDIT_FILE wins over XDG_STATE_HOME inside audit.js, so a suite that sets
  // it (test/e2e.sh does) would point this test at the real trail
  const env = { ...process.env, XDG_STATE_HOME: root };
  delete env.PP_AUDIT_FILE;
  return { root, state, env };
}

test("a missing file is not a problem, a broken one is named", () => {
  const { state, env } = sandbox();
  assert.deepEqual(inspectStateFiles(env), []);

  writeFileSync(join(state, "state.json"), '{"a":1');
  writeFileSync(join(state, "cron.json"), JSON.stringify({ jobs: [] }));
  const results = inspectStateFiles(env);
  const broken = results.find((entry) => entry.file === "state.json");
  assert.equal(broken.ok, false);
  assert.match(broken.problem, /is not valid JSON/);
  assert.equal(results.find((entry) => entry.file === "cron.json").ok, true);
});

test("parseable but wrong shape is a problem too", () => {
  const { state, env } = sandbox();
  writeFileSync(join(state, "state.json"), "[1,2,3]");
  writeFileSync(join(state, "panel.json"), "null");
  const problems = inspectStateFiles(env).filter((entry) => !entry.ok).map((entry) => `${entry.file}: ${entry.problem}`);
  assert.deepEqual(problems, ["state.json: does not contain a JSON object", "panel.json: does not contain a JSON object"]);
});

test("a job with no schedule would never run, and is reported", () => {
  const { state, env } = sandbox();
  writeFileSync(join(state, "cron.json"), JSON.stringify({ jobs: [{ id: "abc", schedule: { kind: "every" } }, { id: "def" }] }));
  const cron = inspectStateFiles(env).find((entry) => entry.file === "cron.json");
  assert.equal(cron.ok, false);
  assert.match(cron.problem, /1 of 2 job\(s\) have no id or schedule/);
});

test("audit lines are read line by line, so one bad line does not hide the rest", () => {
  const { state, env } = sandbox();
  writeFileSync(join(state, "audit.log"), '{"action":"up"}\nnot json\n{"action":"down"}\n');
  const audit = inspectStateFiles(env).find((entry) => entry.file === "audit.log");
  assert.equal(audit.ok, false);
  assert.match(audit.problem, /1 of 3 lines are not JSON/);
});

test("quarantine moves the file aside, keeping it readable", () => {
  const { state, env } = sandbox();
  const path = join(state, "state.json");
  writeFileSync(path, '{"broken":');
  const target = quarantineStateFile(path, env, new Date("2026-11-21T09:00:00Z"));
  assert.equal(target, `${path}.broken-2026-11-21T09-00-00-000Z`);
  assert.equal(readFileSync(target, "utf8"), '{"broken":');
  assert.deepEqual(inspectStateFiles(env), []); // the broken one is out of the way
  assert.equal(quarantineStateFile(path, env), null); // nothing left to move
});

test("the sentence says how many files parsed, or what to type", () => {
  const { state, env } = sandbox();
  writeFileSync(join(state, "state.json"), JSON.stringify({ "/c.yml": { api: { stopped: {} } } }));
  assert.match(describeStateFiles(inspectStateFiles(env), env), /^1 file\(s\) parse, 1 entry$/);
  writeFileSync(join(state, "panel.json"), "oops");
  assert.match(describeStateFiles(inspectStateFiles(env), env), /panel\.json is not valid JSON.*pp doctor --quarantine/);
  assert.match(describeStateFiles([], { XDG_STATE_HOME: state }), /^no state files yet/);
});
