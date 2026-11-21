import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, statSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { humanBytes, parseSize, shrinkTail } from "../src/commands.js";

test("sizes are read the way people write them", () => {
  assert.equal(parseSize("1024"), 1024);
  assert.equal(parseSize("2k"), 2048);
  assert.equal(parseSize("2 KB"), 2048);
  assert.equal(parseSize("1.5m"), 1572864);
  assert.equal(parseSize(2 * 1024 ** 3), 2 * 1024 ** 3);
  assert.throws(() => parseSize("two mb"), /is not a size/);
  assert.equal(humanBytes(999), "999 B");
  assert.equal(humanBytes(1536), "1.5 KB");
  assert.equal(humanBytes(2 * 1024 ** 2), "2.0 MB");
  assert.equal(humanBytes(3 * 1024 ** 3), "3.0 GB");
});

test("shrinking keeps the tail, on a line boundary", () => {
  const dir = mkdtempSync(join(tmpdir(), "pp-clean-"));
  try {
    const file = join(dir, "log.txt");
    // 2000 lines of "line-N", ~14 KB
    writeFileSync(file, Array.from({ length: 2000 }, (_, i) => `line-${i}`).join("\n") + "\n");
    const sizeBefore = statSync(file).size;
    const result = shrinkTail(file, 200);
    assert.equal(result.before, sizeBefore);
    assert.ok(result.after <= 200, `after ${result.after}`);
    assert.ok(result.freed > 10000, `freed ${result.freed}`);
    const text = readFileSync(file, "utf8");
    assert.ok(text.endsWith("line-1999\n"), "the newest line survives");
    assert.match(text.split("\n")[0], /^line-\d+$/, "does not start mid-line");
    // and a file already small enough is left alone
    const small = shrinkTail(file, 10 ** 6);
    assert.deepEqual(small, { before: result.after, after: result.after, freed: 0 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
