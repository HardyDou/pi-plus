import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const readme = readFileSync(join(root, "README.md"), "utf8");

// The README is the only page a stranger reads before installing. Every verb the
// CLI answers to has to appear somewhere in it, or the thing is undiscoverable.
const helpSource = readFileSync(join(root, "test/help.test.js"), "utf8");
const verbs = [...helpSource.match(/const CANONICAL = \[([\s\S]*?)\]/, (m) => m[1])[0].matchAll(/"([^"]+)"/g)].map((m) => m[1]);

test("every command appears in the README", () => {
  const missing = verbs.filter((verb) => !readme.includes(`pp ${verb}`));
  assert.deepEqual(missing, [], `README never mentions: ${missing.join(", ")}`);
});

test("the license section is not where tables go to die", () => {
  const tail = readme.slice(readme.indexOf("## License"));
  assert.ok(tail.length > 0, "README has no license section");
  const stray = tail.split("\n").filter((line) => line.startsWith("| `pp"));
  assert.deepEqual(stray, [], "table rows landed after the license heading");
});
