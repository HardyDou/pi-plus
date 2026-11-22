import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * Documentation rots quietly: a flag gets renamed and the example keeps looking
 * authoritative. Every `--flag` that appears in a `pp …` example must be one the
 * parser actually knows (it appears in bin/pp.js).
 */

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PARSER = readFileSync(join(ROOT, "bin", "pp.js"), "utf8");
const KNOWN = new Set([...PARSER.matchAll(/"(--[a-z0-9-]+)"/g)].map((match) => match[1]));

function files() {
  const docs = readdirSync(join(ROOT, "docs"))
    .filter((name) => name.endsWith(".md"))
    .map((name) => join(ROOT, "docs", name));
  return [join(ROOT, "README.md"), ...docs];
}

function examples(text) {
  // `pp <verb> …` up to the end of the line, ignoring quoted prose after it
  return [...text.matchAll(/pp [a-z][\w-]*(?:[^\n`|]*)?/g)].map((match) => match[0]);
}

test("every flag used in a documented example is one pp parses", () => {
  const unknown = new Map();
  for (const file of files()) {
    for (const example of examples(readFileSync(file, "utf8"))) {
      for (const flag of example.matchAll(/(?<![\w-])(--[a-z][a-z0-9-]*)/g)) {
        if (!KNOWN.has(flag[1])) {
          const where = file.slice(ROOT.length + 1);
          if (!unknown.has(flag[1])) unknown.set(flag[1], new Set());
          unknown.get(flag[1]).add(where);
        }
      }
    }
  }
  assert.deepEqual(
    [...unknown].map(([flag, where]) => `${flag} (${[...where].join(", ")})`),
    [],
    "documented flags that bin/pp.js does not accept",
  );
});

test("the guard can fail", () => {
  assert.ok(!KNOWN.has("--definitely-not-a-flag"));
  assert.deepEqual(examples("run pp up --definitely-not-a-flag now"), ["pp up --definitely-not-a-flag now"]);
});
