import assert from "node:assert/strict";
import test from "node:test";

import { describeNext } from "../src/commands.js";

const at = (iso) => new Date(iso);
const now = at("2026-11-21T10:00:00.000Z");

test("a future run reads as minutes, not as a timestamp to subtract", () => {
  const { text, late } = describeNext(at("2026-11-21T10:03:00.000Z"), now);
  assert.equal(late, false);
  assert.match(text, /^in 3m \(\d\d:\d\d\)$/);
});

test("an overdue job says so — the signature of a tick that stopped firing", () => {
  const { text, late } = describeNext(at("2026-11-21T09:45:00.000Z"), now);
  assert.equal(late, true);
  assert.match(text, /^late 15m \(\d\d:\d\d\)$/);
});

test("long gaps stay coarse, and seconds are only used up close", () => {
  assert.match(describeNext(at("2026-11-21T13:41:00.000Z"), now).text, /^in 4h /);
  assert.match(describeNext(at("2026-11-23T10:00:00.000Z"), now).text, /^in 2d /);
  assert.match(describeNext(at("2026-11-21T10:00:20.000Z"), now).text, /^in 20s /);
  assert.equal(describeNext(null, now).text, "-");
});
