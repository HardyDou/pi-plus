import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, sep } from "node:path";

// The unit's name is a knob so tests (and anyone running two fleets on one
// machine) cannot stop a service they do not own: `systemctl --user stop`
// takes the unit's whole cgroup with it when KillMode says so.
export function serviceName(env = process.env) {
  const name = String(env.PP_UNIT_NAME ?? "").trim();
  return name || "pi-plus";
}


export function isWsl(env = process.env) {
  if (env.WSL_DISTRO_NAME || env.WSL_INTEROP) return true;
  try {
    return readFileSync("/proc/sys/kernel/osrelease", "utf8").toLowerCase().includes("microsoft");
  } catch {
    return false;
  }
}

export function autostartKind() {
  if (process.platform === "linux") return "systemd";
  if (process.platform === "darwin") return "launchd";
  return null;
}

export function systemdUserDir(env = process.env) {
  return join(env.XDG_CONFIG_HOME || join(env.HOME || homedir(), ".config"), "systemd", "user");
}

export function launchAgentPath(env = process.env) {
  return join(env.HOME || homedir(), "Library", "LaunchAgents", "com.pi-plus.plist");
}

function quoteSystemd(value) {
  const v = String(value).replace(/%/g, "%%");
  return `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function xmlEscape(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Directory holding local executables the agent may need (`node_modules/.bin`), if any.
// A global npm install already has its bin dir in PATH via dirname(process.execPath).
function projectBinDir(scriptPath) {
  let dir = dirname(scriptPath);
  for (let depth = 0; depth < 6; depth += 1) {
    if (dir.endsWith(`${sep}node_modules`)) return null;
    const candidate = join(dir, "node_modules", ".bin");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export function buildServicePath(scriptPath, env = process.env) {
  const dirs = [
    dirname(process.execPath),
    projectBinDir(scriptPath),
    env.HOME ? join(env.HOME, ".local", "bin") : null,
    "/usr/local/bin",
    "/opt/homebrew/bin",
    "/home/linuxbrew/.linuxbrew/bin",
    "/usr/bin",
    "/bin",
  ].filter(Boolean);
  return [...new Set(dirs)].join(":");
}

export function renderSystemdService({ scriptPath, configPath, env = process.env, watch = false }) {
  const path = buildServicePath(scriptPath, env);
  const args = [scriptPath, "up", "--config", configPath, "--reconcile", "--quiet"]
    .map(quoteSystemd)
    .join(" ");
  return `[Unit]
Description=pi-plus: start pi agents in tmux
Documentation=https://github.com/HardyDou/pi-plus
After=default.target

[Service]
Type=oneshot
RemainAfterExit=${watch ? "no" : "yes"}
# tmux must outlive this unit: systemd would otherwise kill the sessions
# in this unit's cgroup as soon as the oneshot run finishes.
KillMode=none
WorkingDirectory=%h
Environment=PATH=${path}
ExecStart=/usr/bin/env node ${args}
TimeoutStartSec=300
Nice=5

[Install]
WantedBy=default.target
`;
}

export function renderSystemdTimer({ intervalSeconds = 300, env = process.env } = {}) {
  return `[Unit]
Description=pi-plus: reconcile tmux sessions

[Timer]
OnBootSec=45s
OnUnitActiveSec=${Math.max(30, Math.floor(intervalSeconds))}s
AccuracySec=30s
Persistent=true
Unit=${serviceName(env)}.service

[Install]
WantedBy=timers.target
`;
}

export function renderLaunchAgent({ scriptPath, configPath, env = process.env, watch = 0 }) {
  const path = buildServicePath(scriptPath, env);
  const log = join(env.HOME || homedir(), "Library", "Logs", "pi-plus.log");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.pi-plus</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/env</string>
    <string>node</string>
    <string>${xmlEscape(scriptPath)}</string>
    <string>up</string>
    <string>--config</string>
    <string>${xmlEscape(configPath)}</string>
    <string>--reconcile</string>
    <string>--quiet</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${xmlEscape(path)}</string>
  </dict>
  <key>RunAtLoad</key><true/>
${watch ? `  <key>StartInterval</key><integer>${Math.max(30, Math.floor(watch))}</integer>` : ""}
  <key>ProcessType</key><string>Background</string>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>${xmlEscape(log)}</string>
  <key>StandardErrorPath</key><string>${xmlEscape(log)}</string>
</dict>
</plist>
`;
}

function run(command, args, { allowFailure = false } = {}) {
  const res = spawnSync(command, args, { encoding: "utf8" });
  if (res.error && res.error.code === "ENOENT") {
    return { status: 127, stdout: "", stderr: `${command}: not found` };
  }
  const out = { status: res.status ?? 1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
  if (!allowFailure && out.status !== 0) {
    const detail = (out.stderr || out.stdout || "").trim();
    throw new Error(`${command} ${args.join(" ")} failed${detail ? `: ${detail}` : ""}`);
  }
  return out;
}

export function autostartState(kind = autostartKind()) {
  if (kind === "systemd") {
    const unitName = serviceName();
    const servicePath = join(systemdUserDir(), `${unitName}.service`);
    const unit = `${unitName}.service`;
    if (!existsSync(servicePath)) {
      return { kind, installed: false, enabled: false, active: null, result: null, path: servicePath };
    }
    const enabled = run("systemctl", ["--user", "is-enabled", unit], { allowFailure: true });
    const show = run("systemctl", ["--user", "show", unit, "-p", "ActiveState", "-p", "Result"], {
      allowFailure: true,
    });
    const props = {};
    for (const line of show.stdout.split("\n")) {
      const at = line.indexOf("=");
      if (at > 0) props[line.slice(0, at)] = line.slice(at + 1).trim();
    }
    return {
      kind,
      installed: true,
      enabled: enabled.stdout.trim() === "enabled",
      active: props.ActiveState ?? null,
      result: props.Result ?? null,
      path: servicePath,
    };
  }
  if (kind === "launchd") {
    const plistPath = launchAgentPath();
    const installed = existsSync(plistPath);
    return { kind, installed, enabled: installed, active: null, result: null, path: plistPath };
  }
  return { kind: null, installed: false, enabled: false, active: null, result: null, path: null };
}

/** One-line summary for `pp doctor`. */
export function describeAutostart(state) {
  if (!state.kind) return "unsupported platform";
  const rel = state.path ? state.path.replace(homedir(), "~") : null;
  if (!state.installed) return `${state.kind} (not installed${rel ? `: ${rel}` : ""})`;
  const bits = [state.kind, state.enabled ? "enabled" : "disabled"];
  if (state.active) {
    const failed = state.result && state.result !== "success";
    bits.push(`last run ${failed ? state.result : "ok"}`);
  }
  return bits.join(", ");
}

export function installAutostart({ scriptPath, configPath, watch = false, print = false, dryRun = false } = {}) {
  const kind = autostartKind();
  if (!kind) throw new Error(`no autostart support for platform ${process.platform}`);
  if (kind === "systemd") {
    const dir = systemdUserDir();
    const unitName = serviceName();
    const servicePath = join(dir, `${unitName}.service`);
    const timerPath = join(dir, `${serviceName()}.timer`);
    const service = renderSystemdService({ scriptPath, configPath, watch });
    const timer = watch ? renderSystemdTimer({ intervalSeconds: watch }) : null;
    if (print || dryRun) {
      process.stdout.write(service);
      if (timer) process.stdout.write(`\n# --- ${serviceName()}.timer ---\n${timer}`);
      return { kind, servicePath, timerPath: timer ? timerPath : null, dryRun };
    }
    if (!dryRun) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(servicePath, service, "utf8");
      if (timer) writeFileSync(timerPath, timer, "utf8");
      run("systemctl", ["--user", "daemon-reload"], { allowFailure: true });
      run("systemctl", ["--user", "enable", `${serviceName()}.service`], { allowFailure: true });
      if (timer) {
        run("systemctl", ["--user", "enable", "--now", `${serviceName()}.timer`], { allowFailure: true });
      } else {
        // `restart` (not `start`): the oneshot stays "active (exited)" after a
        // run, so `start` would be a no-op when installing over an old unit —
        // which is exactly the "I ran `pp down`, then `pp install`" case.
        const restarted = run("systemctl", ["--user", "restart", `${serviceName()}.service`], { allowFailure: true });
        if (restarted.status !== 0) {
          run("systemctl", ["--user", "start", `${serviceName()}.service`], { allowFailure: true });
        }
      }
      run("loginctl", ["enable-linger", process.env.USER || ""], { allowFailure: true });
    }
    return { kind, servicePath, timerPath: timer ? timerPath : null, dryRun };
  }

  const plistPath = launchAgentPath();
  const plist = renderLaunchAgent({ scriptPath, configPath, watch });
  if (print || dryRun) {
    process.stdout.write(plist);
    return { kind, plistPath, dryRun };
  }
  if (!dryRun) {
    mkdirSync(dirname(plistPath), { recursive: true });
    writeFileSync(plistPath, plist, "utf8");
    run("launchctl", ["unload", plistPath], { allowFailure: true });
    const uid = typeof process.getuid === "function" ? process.getuid() : "";
    const boot = run("launchctl", ["bootstrap", `gui/${uid}`, plistPath], { allowFailure: true });
    if (boot.status !== 0) run("launchctl", ["load", "-w", plistPath], { allowFailure: true });
  }
  return { kind, plistPath, dryRun };
}

export function uninstallAutostart({ dryRun = false } = {}) {
  const kind = autostartKind();
  if (kind === "systemd") {
    const dir = systemdUserDir();
    const unitName = serviceName();
    const servicePath = join(dir, `${unitName}.service`);
    const timerPath = join(dir, `${serviceName()}.timer`);
    if (!dryRun) {
      run("systemctl", ["--user", "disable", "--now", `${serviceName()}.timer`], { allowFailure: true });
      run("systemctl", ["--user", "disable", "--now", `${serviceName()}.service`], { allowFailure: true });
      for (const p of [servicePath, timerPath]) {
        if (existsSync(p)) rmSync(p, { force: true });
      }
      run("systemctl", ["--user", "daemon-reload"], { allowFailure: true });
    }
    return { kind, removed: [servicePath, timerPath], dryRun };
  }
  if (kind === "darwin") {
    const plistPath = launchAgentPath();
    if (!dryRun) {
      run("launchctl", ["unload", plistPath], { allowFailure: true });
      const uid = typeof process.getuid === "function" ? process.getuid() : "";
      run("launchctl", ["bootout", `gui/${uid}`, plistPath], { allowFailure: true });
      if (existsSync(plistPath)) rmSync(plistPath, { force: true });
    }
    return { kind, removed: [plistPath], dryRun };
  }
  throw new Error(`no autostart support for platform ${process.platform}`);
}
