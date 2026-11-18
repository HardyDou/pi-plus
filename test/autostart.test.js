import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import {
  buildServicePath,
  isWsl,
  renderLaunchAgent,
  renderSystemdService,
  renderSystemdTimer,
} from "../src/autostart.js";

const GLOBAL = "/home/user/.nvm/versions/node/v26.13.1/lib/node_modules/pi-farm/bin/pp.js";

test("service PATH has no bogus node_modules/.bin for a global install", () => {
  const path = buildServicePath(GLOBAL, { HOME: "/home/user" });
  assert.ok(!path.includes("node_modules/node_modules"), path);
  assert.ok(!path.includes("node_modules/.bin"), path);
  const dirs = path.split(":");
  assert.ok(dirs.includes("/home/user/.local/bin"));
  assert.ok(dirs.includes(dirname(process.execPath)), "PATH must contain the running node dir");
  assert.equal(new Set(dirs).size, dirs.length, "PATH entries must be unique");
});

test("service PATH picks up a project node_modules/.bin when present", () => {
  const root = mkdtempSync(join(tmpdir(), "pp-path-"));
  try {
    mkdirSync(join(root, "node_modules", ".bin"), { recursive: true });
    mkdirSync(join(root, "bin"), { recursive: true });
    const path = buildServicePath(join(root, "bin", "pp.js"), { HOME: "/home/user" });
    assert.ok(path.split(":").includes(join(root, "node_modules", ".bin")), path);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("systemd unit runs up with --reconcile and the config path", () => {
  const unit = renderSystemdService({ scriptPath: GLOBAL, configPath: "/home/user/.pi/plus.yml" });
  assert.match(unit, /Type=oneshot/);
  assert.match(unit, /RemainAfterExit=yes/);
  assert.match(unit, /"--config" "\/home\/user\/\.pi\/plus\.yml"/);
  assert.match(unit, /"--reconcile"/);
  assert.match(unit, /WantedBy=default\.target/);
});

test("watch mode leaves the job re-triggerable and pairs with a timer", () => {
  const unit = renderSystemdService({ scriptPath: GLOBAL, configPath: "/tmp/x.yml", watch: true });
  assert.match(unit, /RemainAfterExit=no/);
  assert.match(renderSystemdTimer({ intervalSeconds: 120 }), /OnUnitActiveSec=120s/);
});

test("launchd plist runs at load with the config path", () => {
  const plist = renderLaunchAgent({ scriptPath: GLOBAL, configPath: "/home/user/.pi/plus.yml" });
  assert.match(plist, /<key>Label<\/key><string>com\.pi-plus<\/string>/);
  assert.match(plist, /<key>RunAtLoad<\/key><true\/>/);
  assert.match(plist, /<string>--reconcile<\/string>/);
  assert.match(plist, /<key>StandardOutPath<\/key>/);
});

test("launchd plist adds StartInterval in watch mode", () => {
  const plist = renderLaunchAgent({ scriptPath: GLOBAL, configPath: "/tmp/x.yml", watch: 90 });
  assert.match(plist, /<key>StartInterval<\/key><integer>90<\/integer>/);
});

test("isWsl detects WSL from the environment", () => {
  assert.equal(isWsl({ WSL_DISTRO_NAME: "Ubuntu" }), true);
  assert.equal(isWsl({ WSL_INTEROP: "/run/WSL/1_interop" }), true);
  assert.equal(typeof isWsl(), "boolean");
});
