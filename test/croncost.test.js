import assert from "node:assert/strict";
import test from "node:test";

import { deliveriesPerDay, deliveryTargets } from "../src/commands.js";
import { buildSchedule } from "../src/cron.js";

const noon = new Date("2026-11-23T12:00:00");

test("deliveriesPerDay counts what a schedule really does, not what it looks like", () => {
  assert.equal(deliveriesPerDay(buildSchedule({ every: "10m" })), 144);
  assert.equal(deliveriesPerDay(buildSchedule({ every: "24h" })), 1);
  assert.equal(deliveriesPerDay(buildSchedule({ cron: "*/10 * * * *" }), { now: noon }), 144);
  // weekly and monthly schedules must not read as "never" just because today is quiet
  assert.equal(deliveriesPerDay(buildSchedule({ cron: "0 9 * * 1,2,3" }), { now: noon }), 0.43);
  assert.equal(deliveriesPerDay(buildSchedule({ cron: "0 0 1 * *" }), { now: noon }), 0.04);
  assert.equal(deliveriesPerDay(buildSchedule({ at: new Date("2026-11-24T09:00:00").toISOString(), }, new Date("2026-11-23T12:00:00"))), 1);
});

test("deliveryTargets says how many sessions one delivery reaches", () => {
  const sessions = [{ role: "pm" }, { role: "PM" }, { role: null }, { role: "dev" }];
  assert.equal(deliveryTargets({ session: "api" }, sessions), 1);
  assert.equal(deliveryTargets({ session: "*" }, sessions), 4);
  assert.equal(deliveryTargets({ role: "pm" }, sessions), 2, "role matching ignores case, like the rest of pp");
  assert.equal(deliveryTargets({ role: "qa" }, sessions), 0);
  assert.equal(deliveryTargets({ action: "heal", session: null }, sessions), 1);
  assert.equal(deliveryTargets({ action: "command", session: "api" }, sessions), 1);
});
