import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { diskFloorBytes, freeSpace } from "../src/commands.js";

test("the floor is a gigabyte unless asked otherwise", () => {
  assert.equal(diskFloorBytes({}), 1024 * 1024 * 1024);
  assert.equal(diskFloorBytes({ PP_DISK_MIN_MB: "50" }), 50 * 1024 * 1024);
  // garbage must not turn the check off by accident
  assert.equal(diskFloorBytes({ PP_DISK_MIN_MB: "plenty" }), 1024 * 1024 * 1024);
  assert.equal(diskFloorBytes({ PP_DISK_MIN_MB: "-5" }), 1024 * 1024 * 1024);
  assert.equal(diskFloorBytes({ PP_DISK_MIN_MB: "0" }), 1024 * 1024 * 1024);
});

test("free space is read from the filesystem holding the state dir", () => {
  const dir = mkdtempSync(join(tmpdir(), "pp-disk-"));
  const free = freeSpace(dir);
  assert.ok(free, "statfs should answer for a directory that exists");
  assert.ok(Number.isFinite(free.bytes) && free.bytes > 0, "some bytes are free");
  assert.equal(free.mount, dir);
});

test("a directory that does not exist is unknown, not zero", () => {
  // reporting 0 free would page someone about a missing directory
  assert.equal(freeSpace("/no/such/place/at/all"), null);
});
