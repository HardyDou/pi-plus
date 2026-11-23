import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, truncateSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { verifyBackup } from "../src/backup.js";

function makeBackup(files = { "plus.yml": "version: 1\nsessions: []\n", "state.json": "{}\n" }) {
  const dir = mkdtempSync(join(tmpdir(), "pp-verify-"));
  const written = [];
  for (const [name, text] of Object.entries(files)) {
    writeFileSync(join(dir, name), text);
    written.push({ name, bytes: Buffer.byteLength(text) });
  }
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ at: new Date().toISOString(), files: written }, null, 2));
  return dir;
}

test("a backup that matches its manifest is intact", () => {
  const dir = makeBackup();
  const report = verifyBackup(dir);
  assert.equal(report.ok, true);
  assert.deepEqual(report.problems, []);
  assert.equal(report.files.length, 2);
  assert.equal(report.files.every((file) => file.ok), true);
  rmSync(dir, { recursive: true, force: true });
});

test("a truncated file is not intact — the manifest is the only witness", () => {
  const dir = makeBackup();
  truncateSync(join(dir, "plus.yml"), 4);
  const report = verifyBackup(dir);
  assert.equal(report.ok, false);
  assert.match(report.problems[0], /plus\.yml is 4 B but the manifest says/);
  assert.equal(report.files.find((file) => file.name === "state.json").ok, true);
  rmSync(dir, { recursive: true, force: true });
});

test("a missing file and a missing manifest are both failures", () => {
  const dir = makeBackup();
  rmSync(join(dir, "state.json"));
  const gone = verifyBackup(dir);
  assert.equal(gone.ok, false);
  assert.deepEqual(gone.problems, ["state.json is gone"]);

  const empty = mkdtempSync(join(tmpdir(), "pp-verify-"));
  const noManifest = verifyBackup(empty);
  assert.equal(noManifest.ok, false);
  assert.match(noManifest.problems[0], /has no manifest/);
  rmSync(dir, { recursive: true, force: true });
  rmSync(empty, { recursive: true, force: true });
});
