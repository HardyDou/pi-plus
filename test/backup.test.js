import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  BACKUP_KEEP,
  backupDir,
  backupPlan,
  describeBackup,
  listBackups,
  pruneBackups,
  restorePlan,
  stampName,
  writeBackup,
} from "../src/backup.js";

const sandbox = () => mkdtempSync(join(tmpdir(), "pp-backup-"));

test("a backup is a directory of copies, and it says what it holds", () => {
  const root = sandbox();
  const env = { HOME: root, XDG_STATE_HOME: join(root, "state") };
  mkdirSync(join(root, "state", "pi-plus"), { recursive: true });
  const configPath = join(root, "plus.yml");
  writeFileSync(configPath, "version: 1\nsessions:\n  - name: a\n    cwd: /tmp\n");
  writeFileSync(join(root, "state", "pi-plus", "cron.json"), '{"jobs":[]}\n');

  assert.equal(backupDir(env), join(root, "state", "pi-plus", "backups"));
  const { dir, files } = writeBackup(backupDir(env), backupPlan(configPath, env), new Date("2026-05-01T10:00:00Z"));
  assert.equal(dir, join(backupDir(env), "2026-05-01T10-00-00-000"));
  assert.deepEqual(files.map((file) => file.name).sort(), ["cron.json", "plus.yml"]);
  assert.match(readFileSync(join(dir, "plus.yml"), "utf8"), /name: a/);
  // todo.json and friends are absent, and absence is not an error
  assert.equal(existsSync(join(dir, "todos.json")), false);
  const described = describeBackup(dir);
  assert.equal(described.at, "2026-05-01T10:00:00.000Z");
  // order is the manifest's (copy order), so compare as a map
  assert.deepEqual(
    Object.fromEntries(described.files.map((file) => [file.name, file.bytes])),
    { "plus.yml": files.find((f) => f.name === "plus.yml").bytes, "cron.json": 12 },
  );
});

test("keep N prunes the oldest, and says which", () => {
  const root = sandbox();
  const target = join(root, "backups");
  for (const day of ["01", "02", "03", "04"]) {
    mkdirSync(join(target, `2026-05-${day}T00-00-00`), { recursive: true });
  }
  assert.equal(listBackups(target).length, 4);
  assert.deepEqual(pruneBackups(target, 2), ["2026-05-01T00-00-00", "2026-05-02T00-00-00"]);
  assert.deepEqual(listBackups(target).map((entry) => entry.name), ["2026-05-03T00-00-00", "2026-05-04T00-00-00"]);
  // asking for more than there is removes nothing
  assert.deepEqual(pruneBackups(target, BACKUP_KEEP), []);
});

test("restore maps the copy back onto the live files, and only those", () => {
  const root = sandbox();
  const env = { HOME: root, XDG_STATE_HOME: join(root, "state") };
  mkdirSync(join(root, "state", "pi-plus"), { recursive: true });
  const configPath = join(root, "plus.yml");
  writeFileSync(configPath, "version: 1\n");
  const { dir } = writeBackup(backupDir(env), backupPlan(configPath, env));
  // something the backup does not know about must not be invented
  writeFileSync(join(dir, "stranger.txt"), "hi");

  const plan = restorePlan(configPath, dir, env);
  assert.deepEqual(plan.map((entry) => entry.name), ["plus.yml"]);
  assert.equal(plan[0].to, configPath);
  assert.equal(plan[0].from, join(dir, "plus.yml"));
});

test("a manifest is optional: a hand-made directory still restores", () => {
  const root = sandbox();
  const env = { HOME: root, XDG_STATE_HOME: join(root, "state") };
  const dir = join(root, "hand-made");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "cron.json"), "{}\n");
  assert.deepEqual(describeBackup(dir), { at: null, files: [{ name: "cron.json", bytes: 3 }] });
  assert.deepEqual(restorePlan(null, dir, env).map((entry) => entry.name), ["cron.json"]);
});

test("stamps sort lexicographically and are safe in a path", () => {
  assert.equal(stampName(new Date("2026-05-01T10:00:12.345Z")), "2026-05-01T10-00-12-345");
  const a = stampName(new Date("2026-05-01T09:00:00.000Z"));
  const b = stampName(new Date("2026-05-01T10:00:00.000Z"));
  assert.ok(a < b);
  assert.equal(/[:]/.test(a), false);
  // two runs in the same second must not share a directory
  const first = stampName(new Date("2026-05-01T10:00:12.001Z"));
  const second = stampName(new Date("2026-05-01T10:00:12.002Z"));
  assert.notEqual(first, second);
  assert.ok(first < second);
});
