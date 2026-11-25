import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { COMMANDS } from "../src/help.js";

const ROOT = new URL("..", import.meta.url).pathname;
// Words that follow "pp " in prose without being commands ("pp can", "pp reads").
const PROSE = new Set(
  "can cannot does will installed opens reads remembers saw swallows uses watches drives chmod cli pif a".split(" "),
);

function verbs() {
  const known = new Set();
  for (const command of COMMANDS) {
    known.add(command.name);
    for (const alias of command.aliases ?? []) known.add(alias);
  }
  return known;
}

/**
 * Documentation that names a command nobody can run is worse than no
 * documentation: it sends people to a dead end (this is how `pp node exec` and
 * `pp node drain` survived a release after they were deleted).
 */
test("every pp <verb> in the docs is a command that exists", () => {
  const known = verbs();
  const files = ["README.md", "src/help.js", ...["architecture", "autostart", "cli", "configuration", "cron", "development", "extension", "from-a-mac", "nodes", "todo", "troubleshooting"].map((name) => `docs/${name}.md`)];
  const offenders = [];
  for (const file of files) {
    const text = readFileSync(join(ROOT, file), "utf8");
    for (const match of text.matchAll(/\bpp ([a-z][a-z0-9-]*)\b/g)) {
      const verb = match[1];
      if (known.has(verb) || PROSE.has(verb)) continue;
      offenders.push(`${file}: pp ${verb}`);
    }
  }
  assert.deepEqual([...new Set(offenders)], []);
});

test("every help page names only commands that exist", () => {
  const known = verbs();
  for (const command of COMMANDS) {
    for (const target of command.see ?? []) assert.ok(known.has(target), `${command.name}: see "${target}" is not a command`);
  }
});
