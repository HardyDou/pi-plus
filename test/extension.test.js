import assert from "node:assert/strict";
import { test } from "node:test";

import { extensionPrefix, extensionUpgradeHint } from "../src/commands.js";

// `/pp-*` commands come from the pi extension and npm never upgrades it, so the
// hint has to be exact — a wrong --prefix silently installs into the wrong tree
// (it printed `…/npm/node_modules`, one level too deep, until this test).
test("--prefix is the directory whose node_modules holds the package", () => {
  assert.equal(extensionPrefix("/home/u/.pi/agent/npm/node_modules/pi-farm"), "/home/u/.pi/agent/npm");
  assert.equal(extensionPrefix("/home/u/.npm-global/lib/node_modules/pi-farm"), "/home/u/.npm-global/lib");
  assert.equal(extensionPrefix("/opt/x/pi-farm"), "/opt/x");
  assert.equal(extensionPrefix(""), "");
});

test("the hint appears only when the extension is behind", () => {
  const stale = extensionUpgradeHint({ version: "0.60.0", dir: "/h/.pi/agent/npm/node_modules/pi-farm" }, "0.73.1");
  assert.match(stale, /--prefix \/h\/\.pi\/agent\/npm /);
  assert.match(stale, /pi-farm@0\.73\.1/);
  assert.match(stale, /--registry https:\/\/registry\.npmjs\.org/);
  assert.equal(extensionUpgradeHint({ version: "0.73.1", dir: "/x/node_modules/pi-farm" }, "0.73.1"), null);
  assert.equal(extensionUpgradeHint({ version: "0.74.0", dir: "/x/node_modules/pi-farm" }, "0.73.1"), null);
  assert.equal(extensionUpgradeHint(null, "0.73.1"), null);
  assert.equal(extensionUpgradeHint({ dir: "/x/node_modules/pi-farm" }, "0.73.1"), null);
});
