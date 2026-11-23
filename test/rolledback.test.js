import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { auditedWrite } from "../src/commands.js";

const GOOD = "version: 1\nsessions:\n  - name: a\n    cwd: /tmp\n";

test("an edit that produces an unreadable config is rolled back", () => {
  const dir = mkdtempSync(join(tmpdir(), "pp-write-"));
  const path = join(dir, "plus.yml");
  writeFileSync(path, GOOD);
  const config = { path };
  assert.throws(
    () => auditedWrite({ config, action: "config.changed", target: "a" }, () => writeFileSync(path, "sessions: [\n")),
    (error) => error.rolledBack === true && /pp cannot read/.test(error.message),
  );
  assert.equal(readFileSync(path, "utf8"), GOOD, "the previous file is back");
  rmSync(dir, { recursive: true, force: true });
});

test("a good edit is left alone and reported", () => {
  const dir = mkdtempSync(join(tmpdir(), "pp-write-"));
  const path = join(dir, "plus.yml");
  writeFileSync(path, GOOD);
  const config = { path };
  const result = auditedWrite({ config, action: "config.changed", target: "a" }, () => {
    writeFileSync(path, GOOD.replace("cwd: /tmp", "role: dev\n    cwd: /tmp"));
    return "wrote";
  });
  assert.equal(result, "wrote");
  assert.match(readFileSync(path, "utf8"), /role: dev/);
  rmSync(dir, { recursive: true, force: true });
});
