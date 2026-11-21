import assert from "node:assert/strict";
import test from "node:test";

import { findScenario, renderMarkdown, renderScenario, RUNBOOK } from "../src/runbook.js";

// the programs a step is allowed to start: pp itself, plus the four or five
// tools that are on any machine pp runs on
const ALLOWED = new Set(["pp", "tmux", "ssh", "crontab", "df", "systemctl", "loginctl"]);

test("every scenario is complete and kebab-cased", () => {
  const ids = new Set();
  for (const scenario of RUNBOOK) {
    assert.match(scenario.id, /^[a-z]+(-[a-z]+)*$/, `bad id: ${scenario.id}`);
    assert.ok(!ids.has(scenario.id), `duplicate id: ${scenario.id}`);
    ids.add(scenario.id);
    assert.ok(scenario.title.length > 8, `${scenario.id} needs a title`);
    assert.ok(scenario.symptom.length > 10, `${scenario.id} needs a symptom`);
    assert.ok(scenario.means.length > 40, `${scenario.id} needs an explanation`);
    assert.ok(scenario.steps.length >= 3, `${scenario.id} needs at least three steps`);
    assert.ok(scenario.fix.startsWith("pp "), `${scenario.id} fix must be a pp command`);
    for (const step of scenario.steps) {
      // only commands that exist, so the manual cannot rot into fiction
      assert.ok(ALLOWED.has(step.do.split(/\s+/)[0]), `${scenario.id}: unknown program in "${step.do}"`);
      assert.ok(step.see.length > 5, `${scenario.id}: "${step.do}" needs an expected result`);
    }
  }
});

test("a scenario can be found by id or by a piece of its title", () => {
  assert.equal(findScenario("disk-full")?.id, "disk-full");
  assert.equal(findScenario("DISK-FULL")?.id, "disk-full");
  assert.equal(findScenario("agent has been quiet")?.id, "agent-stuck");
  assert.equal(findScenario("nonsense"), null);
  assert.equal(findScenario(""), null);
});

test("rendering keeps every step in order, with its expectation", () => {
  for (const scenario of RUNBOOK) {
    const text = renderScenario(scenario);
    let last = -1;
    for (const step of scenario.steps) {
      // search forward from the previous hit: a command can also show up inside
      // another step's expected output ("look: pp logs x")
      const at = text.indexOf(step.do, last + 1);
      assert.ok(at > last, `${scenario.id}: ${step.do} is out of order`);
      last = at;
      assert.ok(text.includes(step.see), `${scenario.id}: expectation for ${step.do} is missing`);
    }
    assert.ok(text.includes(scenario.fix), `${scenario.id}: the fix line is missing`);
  }
});

test("the manual covers every scenario", () => {
  const markdown = renderMarkdown();
  for (const scenario of RUNBOOK) {
    assert.ok(markdown.includes(`## ${scenario.title}`), `${scenario.id} is missing from the manual`);
    assert.ok(markdown.includes(scenario.fix), `${scenario.id} fix is missing from the manual`);
  }
  assert.match(markdown, /^# 事故处理手册/);
  // the doc is generated; say so, or somebody will edit it by hand
  assert.match(markdown, /pp runbook --markdown > docs\/runbook\.md/);
});
