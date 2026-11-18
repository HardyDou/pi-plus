import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  addAlias,
  aliasDir,
  AliasError,
  assertAliasName,
  dirOnPath,
  inspectCommandNames,
  listAliases,
  readAlias,
  removeAlias,
} from "../src/aliases.js";

function workspace() {
  // A real file acts as "our CLI"; symlinks point at it.
  const dir = mkdtempSync(join(tmpdir(), "pp-alias-"));
  const bin = join(dir, "bin");
  const cli = join(dir, "pp.js");
  writeFileSync(cli, "#!/usr/bin/env node\n");
  chmodSync(cli, 0o755); // resolveExecutable() only accepts executable files
  mkdirSync(bin);
  return { dir, bin, cli };
}

test("aliasDir defaults to ~/.local/bin and honours PP_BIN_DIR / override", () => {
  const home = process.env.HOME;
  assert.equal(aliasDir({}, null).endsWith("/.local/bin"), true);
  assert.equal(aliasDir({ PP_BIN_DIR: "/opt/pifarm/bin" }, null), "/opt/pifarm/bin");
  assert.equal(aliasDir({}, "~/somewhere"), join(home, "somewhere"));
  assert.equal(aliasDir({ PP_BIN_DIR: "/opt/x" }, "/tmp/y"), "/tmp/y");
});

test("assertAliasName rejects unsafe names", () => {
  for (const name of ["", "-rf", "a b", "a/b", "..", "x;rm"]) {
    assert.throws(() => assertAliasName(name), AliasError, name);
  }
  assert.doesNotThrow(() => assertAliasName("pif"));
  assert.doesNotThrow(() => assertAliasName("pif2.1"));
});

test("addAlias links, is idempotent, and lists only aliases for our target", () => {
  const { dir, bin, cli } = workspace();
  const other = join(dir, "other.js");
  writeFileSync(other, "");

  const first = addAlias("pif", { dir: bin, target: cli });
  assert.equal(first.changed, true);
  assert.equal(realpathSync(first.path), realpathSync(cli));

  const again = addAlias("pif", { dir: bin, target: cli });
  assert.equal(again.changed, false);

  symlinkSync(other, join(bin, "foreign"));
  addAlias("pp2", { dir: bin, target: cli });

  const mine = listAliases({ dir: bin, target: cli }).map((alias) => alias.name);
  assert.deepEqual(mine, ["pif", "pp2"]);
  assert.equal(listAliases({ dir: join(dir, "missing"), target: cli }).length, 0);
});

test("addAlias refuses a real file unless forced", () => {
  const { dir, bin, cli } = workspace();
  writeFileSync(join(bin, "pp"), "#!/bin/sh\necho not us\n");
  assert.throws(() => addAlias("pp", { dir: bin, target: cli }), /is not a symlink/);
  const forced = addAlias("pp", { dir: bin, target: cli, force: true });
  assert.equal(forced.changed, true);
  assert.equal(realpathSync(join(bin, "pp")), realpathSync(cli));
});

test("removeAlias only deletes our own links", () => {
  const { dir, bin, cli } = workspace();
  const other = join(dir, "other.js");
  writeFileSync(other, "");
  addAlias("pif", { dir: bin, target: cli });
  assert.equal(removeAlias("pif", { dir: bin, target: cli }), true);
  assert.equal(existsSync(join(bin, "pif")), false);
  assert.equal(removeAlias("pif", { dir: bin, target: cli }), false);

  symlinkSync(other, join(bin, "foreign"));
  assert.throws(() => removeAlias("foreign", { dir: bin, target: cli }), /points at/);

  writeFileSync(join(bin, "real"), "");
  assert.throws(() => removeAlias("real", { dir: bin, target: cli }), /not a symlink/);
});

test("readAlias reports symlink vs file", () => {
  const { bin, cli } = workspace();
  writeFileSync(join(bin, "real"), "");
  assert.equal(readAlias(bin, "real").symlink, false);
  assert.equal(readAlias(bin, "nope"), null);
  addAlias("pif", { dir: bin, target: cli });
  const alias = readAlias(bin, "pif");
  assert.equal(alias.symlink, true);
  assert.equal(alias.target, cli);
});

test("dirOnPath sees through symlinked PATH entries", () => {
  const { dir, bin } = workspace();
  const linkToBin = join(dir, "pathbin");
  symlinkSync(bin, linkToBin);
  assert.equal(dirOnPath(bin, { PATH: `/usr/bin:${linkToBin}` }), true);
  assert.equal(dirOnPath(bin, { PATH: "/usr/bin" }), false);
});

test("inspectCommandNames separates our names from a foreign one", () => {
  const { dir, bin, cli } = workspace();
  addAlias("pifarm", { dir: bin, target: cli });
  const foreign = join(bin, "pp");
  writeFileSync(foreign, "#!/bin/sh\necho 'Usage: pp [-t type] ...'\n");
  chmodSync(foreign, 0o755);

  const info = inspectCommandNames({ target: cli, env: { PATH: bin } });
  assert.equal(info.ok, true);
  const byName = Object.fromEntries(info.names.map((entry) => [entry.name, entry]));
  assert.equal(byName.pifarm.ours, true);
  assert.equal(byName.pp.ours, false);
  assert.equal(byName["pi-plus"].path, null);

  const shadowed = inspectCommandNames({ target: cli, env: { PATH: `/usr/bin:${dir}` } });
  assert.equal(shadowed.ok, false);
});
