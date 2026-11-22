import assert from "node:assert/strict";
import test from "node:test";
import { describeWindow, inQuietHours, parseWindow } from "../src/cron.js";

const at = (hour, minute = 0) => ({ getHours: () => hour, getMinutes: () => minute });

test("a window that wraps midnight covers both sides of it", () => {
  const night = parseWindow("23:00-08:00");
  assert.deepEqual(night, { from: 1380, to: 480 });
  assert.equal(inQuietHours({ window: night }, at(22, 59)), false, "before it starts");
  assert.equal(inQuietHours({ window: night }, at(23)), true, "the first minute");
  assert.equal(inQuietHours({ window: night }, at(3)), true, "the middle of the night");
  assert.equal(inQuietHours({ window: night }, at(8)), false, "the minute it ends");
});

test("a window inside one day does not leak", () => {
  const lunch = parseWindow("12:00-13:30");
  assert.equal(inQuietHours({ window: lunch }, at(11, 59)), false);
  assert.equal(inQuietHours({ window: lunch }, at(13, 29)), true);
  assert.equal(inQuietHours({ window: lunch }, at(13, 30)), false);
  assert.equal(inQuietHours({ window: lunch }, at(23)), false, "wrapping is only for windows that wrap");
});

test("no window means no quiet hours, and bad windows are refused", () => {
  assert.equal(inQuietHours({}, at(3)), false);
  assert.throws(() => parseWindow("23-8"), /not a time range/);
  assert.throws(() => parseWindow("24:00-08:00"), /does not exist/);
  assert.throws(() => parseWindow("23:00-23:00"), /same minute/);
});

test("describeWindow prints what was typed, zero-padded", () => {
  assert.equal(describeWindow(parseWindow("9:05-17:30")), "09:05-17:30");
});

test("quiet hours are reported as a reason, not as a failure", async () => {
  // the tick's summary line groups skip reasons; "quiet hours" must survive as words
  const { tick } = await import("../src/cron.js");
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "cronwin-"));
  const state = { ...process.env, XDG_STATE_HOME: dir };
  const { writeJobs } = await import("../src/cron.js");
  writeJobs(
    [
      {
        id: "aaaaaa",
        action: "prompt",
        prompt: "hi",
        session: "*",
        socket: null,
        schedule: { kind: "every", every: 600 },
        window: { from: 0, to: 1440 }, // 00:00-24:00: the whole day, however late the test runs
        createdAt: new Date(Date.now() - 3600_000).toISOString(),
        runs: 0,
      },
    ],
    state,
  );
  const result = tick({ now: new Date(), deliver: () => ({ status: "delivered" }), env: state });
  assert.equal(result.ran.length, 0, "nothing is delivered inside the window");
  assert.equal(result.skipped[0].reason, "quiet hours");
});

test("24:00 is an end, not a time of day", () => {
  const allDay = parseWindow("00:00-24:00");
  assert.deepEqual(allDay, { from: 0, to: 24 * 60 }, "the end is exclusive, so the whole day is expressible");
  assert.equal(inQuietHours({ window: allDay }, at(23, 59)), true);
  assert.equal(describeWindow(allDay), "00:00-24:00");
  assert.throws(() => parseWindow("24:00-08:00"), /does not exist/, "but not as a start");
});

test("a tick that loses the lock still answers with a full shape", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { tick, writeJobs } = await import("../src/cron.js");
  const dir = mkdtempSync(join(tmpdir(), "cronlock-"));
  const state = { ...process.env, XDG_STATE_HOME: dir };
  writeJobs([{ id: "aaaaaa", action: "prompt", prompt: "hi", session: "api", schedule: { kind: "every", every: 600 }, createdAt: new Date().toISOString() }], state);
  // somebody else holds the lock, in the same state dir
  mkdirSync(join(dir, "pi-plus"), { recursive: true });
  writeFileSync(join(dir, "pi-plus", "cron.json.lock"), "held\n");
  const result = tick({ now: new Date(), deliver: () => ({ status: "delivered" }), env: state });
  assert.equal(result.locked, true, "the caller can tell it was locked out");
  assert.deepEqual(result.ran, [], "and never has to guard against undefined");
  assert.deepEqual(result.skipped, []);
  assert.equal(result.total, 0);
});
