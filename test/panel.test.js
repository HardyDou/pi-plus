import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { clearPanel, findPanelPane, loadPanel, panelStatePath, savePanel } from "../src/panel.js";

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), "pp-panel-"));
  return {
    env: { XDG_STATE_HOME: dir, HOME: dir },
    dir,
    done: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test("the panel location survives a save/load round trip", () => {
  const box = sandbox();
  try {
    assert.equal(loadPanel(box.env), null, "nothing recorded yet");
    savePanel({ session: "work", window: "2", pane: "%7" }, box.env);
    const panel = loadPanel(box.env);
    assert.equal(panel.session, "work");
    assert.equal(panel.window, "2");
    assert.equal(panel.pane, "%7");
    assert.match(panel.at, /^\d{4}-\d{2}-\d{2}T/);
    assert.ok(panelStatePath(box.env).endsWith(join("pi-plus", "panel.json")));
  } finally {
    box.done();
  }
});

test("a broken or empty record reads as no record", () => {
  const box = sandbox();
  try {
    mkdirSync(join(box.dir, "pi-plus"), { recursive: true });
    writeFileSync(panelStatePath(box.env), "{not json");
    assert.equal(loadPanel(box.env), null);
    writeFileSync(panelStatePath(box.env), JSON.stringify({ session: "" }));
    assert.equal(loadPanel(box.env), null);
    writeFileSync(panelStatePath(box.env), JSON.stringify({ session: "ok", window: 3 }));
    const panel = loadPanel(box.env);
    assert.equal(panel.window, "3", "numbers are coerced to strings");
  } finally {
    box.done();
  }
});

test("clearPanel forgets the panel", () => {
  const box = sandbox();
  try {
    savePanel({ session: "work", window: "0", pane: "%1" }, box.env);
    assert.equal(clearPanel(box.env), true);
    assert.equal(loadPanel(box.env), null);
  } finally {
    box.done();
  }
});

test("findPanelPane matches by pane id, not by session name", () => {
  const list = ["%1 work 0", "%2 other 1", "%3 work 2"].join("\n");
  assert.deepEqual(findPanelPane(list, { session: "work", window: "2", pane: "%3" }), {
    pane: "%3",
    session: "work",
    window: "2",
  });
  assert.equal(findPanelPane(list, { session: "work", window: "2", pane: "%9" }), null, "a dead pane is not found");
  assert.equal(findPanelPane(list, null), null);
});
