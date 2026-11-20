import assert from "node:assert/strict";
import test from "node:test";
import { COMMANDS, commandNames, findCommand, renderCommandHelp, renderOverview, suggestCommand } from "../src/help.js";

const CANONICAL = ["new", "node", "audit", "up", "down", "rm", "restart", "status", "attach", "logs", "send", "mesh", "cron", "todo", "tui", "back", "check", "doctor", "init", "install", "uninstall", "alias", "update", "version", "help"];

test("every command has a complete help page", () => {
  for (const name of CANONICAL) {
    const command = findCommand(name);
    assert.ok(command, `missing help entry for ${name}`);
    const page = renderCommandHelp("0.0.0", name);
    assert.ok(page.includes("Usage:"), `${name}: no usage`);
    assert.ok(page.includes(command.usage), `${name}: usage mismatch`);
    assert.ok(page.includes("Examples:"), `${name}: no examples`);
  }
  assert.deepEqual(
    COMMANDS.map((c) => c.name).sort(),
    [...CANONICAL].sort(),
  );
});

test("aliases resolve to the canonical command", () => {
  for (const [alias, canonical] of [
    ["start", "up"],
    ["n", "new"],
    ["create", "new"],
    ["stop", "down"],
    ["ls", "status"],
    ["list", "status"],
    ["log", "logs"],
    ["validate", "check"],
    ["autostart", "install"],
    ["START", "up"],
  ]) {
    assert.equal(findCommand(alias)?.name, canonical, alias);
  }
  assert.equal(findCommand("nope"), null);
  assert.ok(commandNames().includes("autostart"));
});

test("overview lists every command and its aliases", () => {
  const overview = renderOverview("9.9.9");
  assert.ok(overview.startsWith("pp 9.9.9"));
  for (const name of CANONICAL) assert.ok(overview.includes(`  ${findCommand(name).name}`) || overview.includes(name));
  for (const command of COMMANDS) {
    for (const alias of command.aliases ?? []) assert.ok(overview.includes(alias), alias);
  }
  assert.ok(overview.includes("restart policies"));
  assert.ok(overview.includes("unless-stopped"));
});

test("typos get a suggestion, wild guesses do not", () => {
  assert.equal(suggestCommand("instal"), "install");
  assert.equal(suggestCommand("statsu"), "status");
  assert.equal(suggestCommand("xyzzy"), null);
});
