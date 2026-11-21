import assert from "node:assert/strict";
import test from "node:test";

import { compareNames, rolesInUse } from "../src/commands.js";
import { cmdRole } from "../src/commands.js";

test("names sort the way a person reads them, families stay together", () => {
  const names = ["risk-pm", "risk-10", "alpha", "risk-2", "risk-01", "Risk-02"];
  const sorted = names.sort(compareNames);
  assert.equal(sorted[0], "alpha");
  assert.equal(sorted[sorted.length - 1], "risk-pm");
  // every risk-* session is contiguous: that is what "shows together" means
  const family = sorted.filter((name) => name.toLowerCase().startsWith("risk-"));
  assert.equal(family.length, 5);
  assert.deepEqual(sorted.slice(1), family);
});

test("numeric ordering beats plain character order", () => {
  assert.ok(compareNames("risk-2", "risk-10") < 0, "risk-2 before risk-10");
  assert.ok(compareNames("risk-01", "risk-02") < 0);
  // and the family is adjacent: nothing sorts between risk-02 and risk-pm
  assert.ok(compareNames("risk-02", "risk-pm") < 0);
});

test("rolesInUse counts the labels actually written down", () => {
  const config = {
    sessions: [
      { name: "risk-02", role: "risk" },
      { name: "web", role: "dev" },
      { name: "risk-01", role: "risk" },
      { name: "spare" },
      { name: "ops", role: "ops" },
    ],
  };
  const roles = rolesInUse(config);
  // most used first, then by name: the answer to "what words do we use?"
  assert.deepEqual(roles.map((entry) => entry.role), ["risk", "dev", "ops"]);
  assert.equal(roles[0].count, 2);
  assert.deepEqual(roles[0].sessions, ["risk-01", "risk-02"], "members are listed in reading order");
  assert.deepEqual(rolesInUse({ sessions: [{ name: "a" }] }), [], "no labels, no rows");
});

function quietExitCode(run) {
  // cmdRole sets process.exitCode when it refuses; a test must not inherit it
  const before = process.exitCode;
  try {
    return run();
  } finally {
    process.exitCode = before;
  }
}

function fakeUi() {
  const lines = [];
  return {
    lines,
    paint: (_style, text) => text,
    out: (line) => lines.push(String(line)),
    info: (line) => lines.push(String(line)),
    warn: (line) => lines.push(String(line)),
    error: (line) => lines.push(`error: ${line}`),
  };
}

test("a label one typo away from an existing one is refused, not created", () => {
  const config = {
    path: "/tmp/none.yml",
    sessions: [
      { name: "web", tmuxName: "web", role: "dev" },
      { name: "spare", tmuxName: "spare" },
    ],
  };
  const caseOnly = fakeUi();
  quietExitCode(() => cmdRole(config, { names: ["spare", "DEV"] }, caseOnly));
  assert.match(caseOnly.lines.join("\n"), /already "dev"/, "a case-only difference is still a second label");
  assert.equal(config.sessions.find((s) => s.name === "spare").role ?? null, null, "nothing written");

  const oneEdit = fakeUi();
  quietExitCode(() => cmdRole(config, { names: ["spare", "deu"] }, oneEdit));
  assert.match(oneEdit.lines.join("\n"), /one edit away from "dev"/);
  assert.equal(config.sessions.find((s) => s.name === "spare").role ?? null, null, "still nothing written");

  // a genuinely different word is allowed (dry-run, so the missing file is moot)
  const fresh = fakeUi();
  cmdRole(config, { names: ["spare", "devel"], dryRun: true }, fresh);
  assert.match(fresh.lines.join("\n"), /devel/);
});

test("a transposition is a typo, not a new label", () => {
  const config = {
    path: "/tmp/none.yml",
    sessions: [
      { name: "web", tmuxName: "web", role: "dev" },
      { name: "spare", tmuxName: "spare" },
    ],
  };
  const ui = fakeUi();
  quietExitCode(() => cmdRole(config, { names: ["spare", "dve"] }, ui));
  assert.match(ui.lines.join("\n"), /"dve" is one edit away from "dev"/);
});
