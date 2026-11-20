import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { MAX_BYTES, agoText, auditActor, auditPath, formatAuditEntry, pruneAudit, readAudit, recordAudit, stateDir } from "../src/audit.js";

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), "pp-audit-"));
  const file = join(dir, "audit.log");
  return { dir, file, env: { ...process.env, PP_AUDIT_FILE: file } };
}

test("the trail lives under the state dir unless PP_AUDIT_FILE says otherwise", () => {
  assert.equal(auditPath({ HOME: "/home/someone" }), "/home/someone/.local/state/pi-plus/audit.log");
  assert.equal(auditPath({ HOME: "/home/someone", XDG_STATE_HOME: "/var/state" }), "/var/state/pi-plus/audit.log");
  assert.equal(auditPath({ PP_AUDIT_FILE: "/tmp/x.log" }), "/tmp/x.log");
  assert.equal(stateDir({ HOME: "/home/someone", XDG_STATE_HOME: "" }), "/home/someone/.local/state/pi-plus");
});

test("an entry records who did what, and reads back", () => {
  const { file, env } = sandbox();
  recordAudit({ action: "down", target: "risk-01", detail: "1 stopped", result: "ok" }, env);
  const [entry] = readAudit({}, env);
  assert.equal(entry.action, "down");
  assert.equal(entry.target, "risk-01");
  assert.equal(entry.detail, "1 stopped");
  assert.equal(entry.result, "ok");
  assert.match(entry.actor, /@/);
  assert.match(entry.actor, /#\d+$/);
  assert.match(entry.ts, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(auditActor(env, 4321).endsWith("#4321"), true);
  rmSync(join(file, ".."), { recursive: true, force: true });
});

test("filters: action, target, since, limit", () => {
  const { dir, env } = sandbox();
  recordAudit({ action: "up", target: "a" }, env);
  recordAudit({ action: "down", target: "b" }, env);
  recordAudit({ action: "down", target: "a" }, env);
  assert.equal(readAudit({}, env).length, 3);
  assert.equal(readAudit({ action: "down" }, env).length, 2);
  assert.equal(readAudit({ target: "a" }, env).length, 2);
  assert.equal(readAudit({ action: "down", target: "a" }, env).length, 1);
  assert.equal(readAudit({ limit: 1 }, env)[0].target, "a");
  assert.equal(readAudit({ since: new Date(Date.now() + 1000) }, env).length, 0);
  assert.equal(readAudit({}, { PP_AUDIT_FILE: join(dir, "missing.log") }).length, 0);
  rmSync(dir, { recursive: true, force: true });
});

test("an unwritable path is swallowed: the command it describes still runs", () => {
  const blocked = join(tmpdir(), `pp-audit-dir-${process.pid}`);
  writeFileSync(blocked, "", "utf8");
  const env = { PP_AUDIT_FILE: join(blocked, "audit.log") };
  assert.equal(recordAudit({ action: "up" }, env), false);
  assert.equal(readAudit({}, env).length, 0);
  rmSync(blocked, { force: true });
});

test("the file is rotated once it passes MAX_BYTES", () => {
  const { dir, file, env } = sandbox();
  writeFileSync(file, `${"x".repeat(1024)}\n`.repeat(Math.ceil(MAX_BYTES / 1025) + 2));
  recordAudit({ action: "up", target: "fresh" }, env);
  assert.equal(existsSync(`${file}.1`), true);
  assert.equal(statSync(file).size < 4096, true, "the new file only holds the new entry");
  assert.equal(readAudit({}, env).at(-1).target, "fresh");
  rmSync(dir, { recursive: true, force: true });
});

test("prune drops old entries and keeps the rest", () => {
  const { dir, file, env } = sandbox();
  const old = new Date(Date.now() - 90 * 86400 * 1000).toISOString();
  writeFileSync(file, `${JSON.stringify({ ts: old, actor: "a@b#1", action: "down", target: "old" })}\nnot json\n`);
  recordAudit({ action: "up", target: "new" }, env);
  const result = pruneAudit({ olderThan: new Date(Date.now() - 30 * 86400 * 1000) }, env);
  assert.equal(result.kept, 1);
  assert.equal(result.dropped, 2, "the old entry and the unparseable line");
  const text = readFileSync(file, "utf8");
  assert.equal(text.includes("old"), false);
  assert.equal(readAudit({}, env).at(-1).target, "new");
  rmSync(dir, { recursive: true, force: true });
});

test("entries read as one line each", () => {
  const now = new Date("2026-11-20T12:00:00.000Z");
  const line = formatAuditEntry(
    { ts: "2026-11-20T11:30:00.000Z", action: "down", target: "risk-01", node: "p201", detail: "1 stopped", result: "ok" },
    now,
  );
  assert.match(line, /^\s*30m ago\s+down\s+risk-01 on p201 — 1 stopped \(ok\)$/);
  assert.equal(agoText("2026-11-20T11:59:30.000Z", now), "30s ago");
  assert.equal(agoText("2026-11-19T12:00:00.000Z", now), "1d ago");
  assert.equal(agoText("nonsense", now), "?");
});

test("a read-only trail is reported, not thrown", () => {
  const { dir, file, env } = sandbox();
  recordAudit({ action: "up", target: "before" }, env);
  chmodSync(file, 0o400);
  const wrote = recordAudit({ action: "up", target: "after" }, env);
  const entries = readAudit({}, env);
  chmodSync(file, 0o600);
  assert.equal(wrote, false, "the caller learns it did not land");
  assert.equal(entries.length, 1, "and reading still works");
  assert.equal(entries[0].target, "before");
  rmSync(dir, { recursive: true, force: true });
});
