import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ageOf, listPiSessions, sessionDirFor } from "../src/pi-sessions.js";

const HOME = mkdtempSync(join(tmpdir(), "pp-pi-"));
const CWD = "/data/work/project";
const DIR = sessionDirFor(CWD, { HOME });

test("the session directory is pi's slug for the cwd", () => {
  assert.equal(sessionDirFor("/data/work", { HOME }), join(HOME, ".pi/agent/sessions/--data-work--"));
  assert.equal(sessionDirFor("/data/x/y/", { HOME }), join(HOME, ".pi/agent/sessions/--data-x-y--"));
});

test("conversations come back newest first, broken files are skipped", () => {
  mkdirSync(DIR, { recursive: true });
  const older = join(DIR, "2026-11-20T00-00-00-000Z_aaa.jsonl");
  const newer = join(DIR, "2026-11-22T00-00-00-000Z_01a1e833-6bdc-7139-abc2-bdb6706d849d.jsonl");
  writeFileSync(older, `{"type":"session","id":"aaa","cwd":"${CWD}"}\n`);
  writeFileSync(newer, `{"type":"session","id":"01a1e833-6bdc-7139-abc2-bdb6706d849d","cwd":"${CWD}"}\n`);
  utimesSync(older, new Date("2026-11-20T00:00:00Z"), new Date("2026-11-20T00:00:00Z"));
  utimesSync(newer, new Date("2026-11-22T00:00:00Z"), new Date("2026-11-22T00:00:00Z"));
  writeFileSync(join(DIR, "2026-11-21T00-00-00-000Z_half.jsonl"), `{"type":"sess`); // truncated
  writeFileSync(join(DIR, "not-a-session.txt"), "ignore me");
  const { sessions } = listPiSessions(CWD, { HOME });
  assert.deepEqual(sessions.map((entry) => entry.id), ["01a1e833-6bdc-7139-abc2-bdb6706d849d", "aaa"]);
  assert.equal(sessions[0].bytes > 0, true);
});

test("a directory without conversations is empty, not an error", () => {
  const { dir, sessions } = listPiSessions("/nowhere", { HOME });
  assert.match(dir, /--nowhere--$/);
  assert.deepEqual(sessions, []);
});

test("ages read like the rest of pp", () => {
  const now = Date.parse("2026-11-23T12:00:00Z");
  assert.equal(ageOf(now - 1000, now), "1s ago");
  assert.equal(ageOf(now - 90_000, now), "2m ago");
  assert.equal(ageOf(now - 3 * 3600_000, now), "3h ago");
  assert.equal(ageOf(now - 48 * 3600_000, now), "2d ago");
  assert.equal(ageOf(now + 5000, now), "0s ago");
});

test("cleanup", () => rmSync(HOME, { recursive: true, force: true }));
