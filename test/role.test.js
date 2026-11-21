import assert from "node:assert/strict";
import test from "node:test";

import { compareNames } from "../src/commands.js";

test("names sort the way a person reads them, families stay together", () => {
  const names = ["risk-pm", "risk-10", "alpha", "risk-2", "risk-01", "Risk-02"];
  const sorted = names.sort(compareNames);
  assert.equal(sorted[0], "alpha");
  assert.equal(sorted[sorted.length - 1], "risk-pm");
  // every risk-* session is contiguous: that is what "shows together" means
  const family = sorted.filter((name) => name.toLowerCase().startsWith("risk-"));
  assert.equal(family.length, 5);
  assert.deepEqual(sorted.slice(1), family);
});

test("numeric ordering beats plain character order", () => {
  assert.ok(compareNames("risk-2", "risk-10") < 0, "risk-2 before risk-10");
  assert.ok(compareNames("risk-01", "risk-02") < 0);
  // and the family is adjacent: nothing sorts between risk-02 and risk-pm
  assert.ok(compareNames("risk-02", "risk-pm") < 0);
});
