import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import {
  buildServicePath,
  describeAutostart,
  isWsl,
  renderLaunchAgent,
  renderSystemdService,
  renderSystemdTimer,
  serviceName,
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
  // without KillMode=none systemd kills the tmux sessions when the unit exits
  assert.match(unit, /KillMode=none/);
  assert.match(unit, /"--config" "\/home\/user\/\.pi\/plus\.yml"/);
  assert.match(unit, /"--reconcile"/);
  assert.match(unit, /WantedBy=default\.target/);
});

test("watch mode leaves the job re-triggerable and pairs with a timer", () => {
  const unit = renderSystemdService({ scriptPath: GLOBAL, configPath: "/tmp/x.yml", watch: true });
  assert.match(unit, /RemainAfterExit=no/);
  // Monotonic OnUnitActiveSec left a oneshot timer with no next elapse at all
  // ("Trigger: n/a"), so the schedule is calendar-based whenever it can be.
  const timer = renderSystemdTimer({ intervalSeconds: 120 });
  assert.match(timer, /OnCalendar=\*:0\/2$/m);
  assert.doesNotMatch(timer, /OnUnitActiveSec/);
  assert.match(renderSystemdTimer({ intervalSeconds: 45 }), /OnUnitInactiveSec=45s/);
  assert.match(renderSystemdTimer({ intervalSeconds: 300 }), /OnCalendar=\*:0\/5$/m);
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

test("describeAutostart summarises install/enable/last-run state", () => {
  assert.equal(describeAutostart({ kind: "systemd", installed: false, enabled: false, active: null, result: null }), "systemd (not installed)");
  // A service without a timer only fires at boot, and saying just "enabled"
  // made the two cases indistinguishable -- that was the false green.
  assert.equal(
    describeAutostart({ kind: "systemd", installed: true, enabled: true, active: "active", result: "success" }),
    "systemd, enabled, no timer: it only runs at boot — pp install --watch 300, last run ok",
  );
  assert.equal(
    describeAutostart({
      kind: "systemd",
      installed: true,
      enabled: true,
      active: "active",
      result: "success",
      timerInstalled: true,
      timerEnabled: true,
      timerInterval: 300,
    }),
    "systemd, enabled, timer every 300s, last run ok",
  );
  assert.match(
    describeAutostart({ kind: "systemd", installed: true, enabled: false, active: "failed", result: "exit-code" }),
    /systemd, disabled, .*last run exit-code/,
  );
  assert.equal(describeAutostart({ kind: null }), "unsupported platform");
});

test("the unit name is a knob, so a test run cannot stop the real service", () => {
  // `systemctl --user stop` takes the unit's cgroup with it: if the e2e suite
  // installed its unit under the production name, stopping it would kill the
  // tmux server the user relies on. That is exactly what happened once.
  assert.equal(serviceName({}), "pi-plus");
  assert.equal(serviceName({ PP_UNIT_NAME: "" }), "pi-plus");
  assert.equal(serviceName({ PP_UNIT_NAME: "  " }), "pi-plus");
  assert.equal(serviceName({ PP_UNIT_NAME: "pi-plus-e2e" }), "pi-plus-e2e");
  // rendered from an explicit env, so a PP_UNIT_NAME in the caller's shell
  // cannot make this test lie
  assert.match(renderSystemdTimer({ intervalSeconds: 60, env: {} }), /Unit=pi-plus\.service/);
  assert.match(renderSystemdTimer({ intervalSeconds: 60, env: { PP_UNIT_NAME: "other" } }), /Unit=other\.service/);
});

test("a unit whose paths moved is not healthy", async () => {
  const { renderSystemdService, unitHealth } = await import("../src/autostart.js");
  const text = renderSystemdService({ scriptPath: "/srv/pp.js", configPath: "/home/u/.pi/plus.yml" });
  const present = new Set(["/srv/pp.js"]);
  const exists = (path) => present.has(path) || path.endsWith("/node");
  assert.deepEqual(unitHealth(text, { exists }).problems, []);

  const moved = unitHealth(text.replace("/srv/pp.js", "/old/pp.js"), { exists });
  assert.equal(moved.ok, false);
  assert.deepEqual(moved.problems, ["the unit runs /old/pp.js, which is gone"]);

  // a node that moved out of the unit's PATH is the other half of the same bug
  const noNode = unitHealth(text, { exists: (path) => path === "/srv/pp.js" });
  assert.equal(noNode.ok, false);
  assert.match(noNode.problems.join(" "), /PATH has no node/);
});
