import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import {
  buildSessionArgv,
  describeSession,
  isSessionPath,
  loadConfig,
  resolve,
  shellQuote,
} from "./config.js";
import { readRemotePiConfig, remotePiConfigPath, writeRemotePiName } from "./remote-pi.js";
import { resolveExecutable, Tmux } from "./tmux.js";
import { installAutostart, uninstallAutostart, autostartKind, launchAgentPath, systemdUserDir } from "./autostart.js";
import { EXAMPLE_CONFIG } from "./example.js";

const COLORS = {
  reset: "\u001b[0m",
  dim: "\u001b[2m",
  bold: "\u001b[1m",
  red: "\u001b[31m",
  green: "\u001b[32m",
  yellow: "\u001b[33m",
  cyan: "\u001b[36m",
};

function makeUi({ json = false, quiet = false, color = true } = {}) {
  const useColor = color && !json && process.stdout.isTTY && !process.env.NO_COLOR;
  const paint = (name, text) => (useColor ? `${COLORS[name]}${text}${COLORS.reset}` : text);
  return {
    json,
    quiet,
    paint,
    out: (line = "") => {
      if (!quiet || json) process.stdout.write(`${line}\n`);
    },
    info: (line) => {
      if (!quiet) process.stdout.write(`${line}\n`);
    },
    warn: (line) => {
      if (!quiet) process.stderr.write(`${paint("yellow", "warning:")} ${line}\n`);
    },
    error: (line) => process.stderr.write(`${paint("red", "error:")} ${line}\n`),
  };
}

function requireConfig(options, ui) {
  let config;
  try {
    config = loadConfig({ configPath: options.config, cwd: options.cwd });
  } catch (err) {
    ui.error(err.message);
    process.exit(2);
  }
  if (!config) {
    ui.error(
      "no config found. Run `pi-farm init` or pass --config <path>.\n" +
        "Looked for: ./pi-farm.yml, ~/.pi/farm.yml, $XDG_CONFIG_HOME/pi-farm/config.yml",
    );
    process.exit(2);
  }
  if (!ui.quiet && options.showWarnings !== false) {
    for (const warning of config.warnings ?? []) ui.warn(warning);
  }
  return config;
}

function selectSessions(config, names, ui, { all = false } = {}) {
  if (!names || names.length === 0) {
    return all ? config.sessions : config.sessions.filter((s) => s.enabled !== false);
  }
  const byKey = new Map();
  for (const s of config.sessions) {
    byKey.set(s.name, s);
    byKey.set(s.tmuxName, s);
  }
  const picked = [];
  for (const name of names) {
    const session = byKey.get(name);
    if (!session) {
      ui.error(`unknown session "${name}" in ${config.path}`);
      process.exit(2);
    }
    if (session.enabled === false) {
      ui.warn(`"${session.name}" has enabled: false; starting it anyway because you asked explicitly`);
    }
    if (!picked.includes(session)) picked.push(session);
  }
  return picked;
}

function makeTmux(config, options) {
  return new Tmux({
    socket: options.socket ?? config?.tmuxSocket ?? null,
    dryRun: options.dryRun,
    verbose: options.verbose,
  });
}

function launchSpec(session, tmux) {
  const argv = buildSessionArgv(session);
  argv[0] = resolveExecutable(argv[0]);
  const env = { ...session.env };
  if (session.remotePiName && session.remotePiMode === "env") {
    env.REMOTE_PI_DIRECT_CONFIG = JSON.stringify({
      ...readRemotePiConfig(session.cwd),
      agent_name: session.remotePiName,
    });
  }
  return { argv, env };
}

function prepareSession(session, { dryRun = false } = {}) {
  if (!existsSync(session.cwd) || !statSync(session.cwd).isDirectory()) {
    throw new Error(`session "${session.name}": cwd does not exist: ${session.cwd}`);
  }
  if (session.remotePiName && session.remotePiMode === "config" && !dryRun) {
    writeRemotePiName(session.cwd, session.remotePiName);
  }
}

function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

async function verifyStartup(tmux, session, ui) {
  await sleep(600);
  const live = tmux.listSessions().get(session.tmuxName);
  if (!live) {
    throw new Error(
      `session "${session.name}" exited immediately. Command: ${describeSession(session)}\n` +
        `Check the agent command, cwd and pi flags (try --verbose).`,
    );
  }
  const dead = live.panes.every((p) => p.dead);
  if (dead) {
    const tail = tmux.capture(session.tmuxName, 30).trim();
    throw new Error(
      `session "${session.name}" started but its pane is dead.\n` +
        (tail ? `Last output:\n${tail}` : "No output captured."),
    );
  }
  if (ui) ui.info(`  ${ui.paint("dim", "pid")} ${live.panes[0]?.pid ?? "?"}`);
}

async function cmdUp(config, options, ui) {
  const sessions = selectSessions(config, options.names, ui);
  const tmux = makeTmux(config, options);
  let started = 0;
  let skipped = 0;
  const failures = [];

  for (const session of sessions) {
    try {
      if (tmux.sessionExists(session.tmuxName)) {
        if (!options.force) {
          skipped++;
          ui.info(`${ui.paint("dim", "skip")}    ${session.tmuxName} ${ui.paint("dim", "(already running)")}`);
          continue;
        }
        ui.info(`${ui.paint("yellow", "recreate")} ${session.tmuxName}`);
        tmux.kill(session.tmuxName);
      }

      prepareSession(session, options);
      const spec = launchSpec(session, tmux);
      if (options.dryRun) {
        const envPairs = Object.entries(spec.env).map(([k, v]) => `${k}=${shellQuote(v)}`);
        const prefix = envPairs.length ? `env ${envPairs.join(" ")} ` : "";
        ui.info(
          `[dry-run] tmux new-session -d -s ${session.tmuxName} -c ${session.cwd} -- ${prefix}${spec.argv
            .map(shellQuote)
            .join(" ")}`,
        );
        started++;
        continue;
      }
      tmux.create(session, spec);
      await verifyStartup(tmux, session, options.quiet ? null : ui);
      started++;
      ui.info(`${ui.paint("green", "started")} ${session.name} ${ui.paint("dim", `→ tmux:${session.tmuxName}  cwd:${session.cwd}`)}`);
      if (session.pi) {
        const bits = [];
        if (session.piSessionName) bits.push(`name=${session.piSessionName}`);
        if (session.piSession) {
          bits.push(`${isSessionPath(session.piSession) ? "session" : "session-id"}=${session.piSession}`);
        }
        if (bits.length) ui.info(`        ${ui.paint("dim", `pi ${bits.join(" ")}`)}`);
      }
      if (session.remotePiName) {
        ui.info(`        ${ui.paint("dim", `remote-pi name=${session.remotePiName} (${session.remotePiMode})`)}`);
      }
    } catch (err) {
      failures.push({ session: session.name, error: err.message });
      ui.error(err.message);
    }
  }

  if (ui.json) {
    ui.out(JSON.stringify({ started, skipped, failures }, null, 2));
  } else if (!options.quiet) {
    const verb = options.dryRun ? "would start" : "started";
    ui.info(
      `\n${started} ${verb}, ${skipped} already running${failures.length ? `, ${failures.length} failed` : ""}.`,
    );
    if (started && !options.dryRun) ui.info(`Attach with: pi-farm attach ${sessions[0]?.name ?? "<name>"}`);
  }
  if (failures.length) process.exitCode = 1;
}

function cmdDown(config, options, ui) {
  // Stopping is always safe: a bare "down" stops everything, enabled or not.
  const sessions = selectSessions(config, options.names, ui, { all: true });
  const tmux = makeTmux(config, options);
  let killed = 0;
  let missing = 0;
  for (const session of sessions) {
    if (!tmux.sessionExists(session.tmuxName)) {
      missing++;
      ui.info(`${ui.paint("dim", "absent")}  ${session.tmuxName}`);
      continue;
    }
    tmux.kill(session.tmuxName);
    killed++;
    ui.info(`${ui.paint("red", "stopped")} ${session.tmuxName}`);
  }
  if (ui.json) ui.out(JSON.stringify({ killed, missing }, null, 2));
  else if (!options.quiet) ui.info(`\n${killed} stopped, ${missing} not running.`);
}

async function cmdRestart(config, options, ui) {
  const sessions = selectSessions(config, options.names, ui);
  const tmux = makeTmux(config, options);
  for (const session of sessions) {
    if (tmux.sessionExists(session.tmuxName)) tmux.kill(session.tmuxName);
  }
  options.force = true;
  await cmdUp({ ...config, sessions }, options, ui);
}

function cmdStatus(config, options, ui) {
  // status lists every configured session, including enabled: false ones.
  const sessions = selectSessions(config, options.names, ui, { all: true });
  const tmux = makeTmux(config, options);
  const live = tmux.listSessions();

  const rows = sessions.map((session) => {
    const entry = live.get(session.tmuxName);
    const pane = entry?.panes[0];
    let state = "stopped";
    let pid = "";
    let command = "";
    if (entry && pane) {
      if (pane.dead) state = "dead";
      else if (entry.attached > 0) state = "attached";
      else state = "running";
      pid = String(pane.pid ?? "");
      command = pane.command ?? "";
    }
    return {
      name: session.name,
      tmux: session.tmuxName,
      state,
      enabled: session.enabled !== false,
      pid,
      command,
      cwd: session.cwd,
      pi: session.pi,
      piSession: session.piSession ?? "",
      piSessionName: session.piSessionName ?? "",
      remotePiName: session.remotePiName ?? "",
    };
  });

  if (ui.json) {
    ui.out(JSON.stringify(rows, null, 2));
    return;
  }

  const headers = ["NAME", "STATE", "PID", "AGENT", "CWD", "PI SESSION", "REMOTE-PI"];
  const table = rows.map((r) => [
    r.name,
    r.state,
    r.pid,
    r.command,
    r.cwd,
    !r.pi
      ? "-"
      : r.piSession
        ? `${r.piSessionName ? `${r.piSessionName} ` : ""}(${r.piSession})`
        : r.piSessionName
          ? `${r.piSessionName} (new)`
          : "(new)",
    r.remotePiName,
  ]);
  const widths = headers.map((h, i) => Math.max(h.length, ...table.map((row) => row[i].length)));
  const pad = (value, width) => value + " ".repeat(Math.max(0, width - value.length));
  ui.out(ui.paint("bold", headers.map((h, i) => pad(h, widths[i])).join("  ").trimEnd()));
  rows.forEach((row, i) => {
    const colored = [...table[i]];
    if (row.enabled === false && row.state === "stopped") {
      colored[1] = ui.paint("dim", "off");
    }
    const color = row.state === "running" ? "green" : row.state === "attached" ? "cyan" : row.state === "dead" ? "red" : "dim";
    colored[1] = ui.paint(color, colored[1]);
    ui.out(colored.map((cell, idx) => pad(cell, widths[idx])).join("  ").trimEnd());
  });
  if (!options.quiet) {
    const running = rows.filter((r) => r.state === "running" || r.state === "attached").length;
    ui.out(`\n${running}/${rows.length} running  ${ui.paint("dim", `config: ${config.path}`)}`);
  }
}

async function cmdAttach(config, options, ui) {
  const name = options.names[0];
  if (!name) {
    ui.error("usage: pi-farm attach <name>");
    process.exit(2);
  }
  const [session] = selectSessions(config, [name], ui);
  const tmux = makeTmux(config, options);
  if (!tmux.sessionExists(session.tmuxName)) {
    ui.info(`${session.tmuxName} is not running; starting it first...`);
    await cmdUp({ ...config, sessions: [session] }, { ...options, names: [], quiet: false }, ui);
    if (!tmux.sessionExists(session.tmuxName)) {
      ui.error(`could not start "${session.name}"`);
      process.exit(1);
    }
  }
  const code = tmux.attach(session.tmuxName);
  process.exit(code);
}

function cmdLogs(config, options, ui) {
  const name = options.names[0];
  if (!name) {
    ui.error("usage: pi-farm logs <name> [--lines N]");
    process.exit(2);
  }
  const [session] = selectSessions(config, [name], ui);
  const tmux = makeTmux(config, options);
  if (!tmux.sessionExists(session.tmuxName)) {
    ui.error(`session "${session.name}" is not running`);
    process.exit(1);
  }
  const output = tmux.capture(session.tmuxName, options.lines ?? 200);
  process.stdout.write(output.endsWith("\n") ? output : `${output}\n`);
}

function cmdSend(config, options, ui) {
  const [name, ...rest] = options.names;
  if (!name || rest.length === 0) {
    ui.error('usage: pi-farm send <name> "text" [--no-enter]');
    process.exit(2);
  }
  const [session] = selectSessions(config, [name], ui);
  const tmux = makeTmux(config, options);
  if (!tmux.sessionExists(session.tmuxName)) {
    ui.error(`session "${session.name}" is not running`);
    process.exit(1);
  }
  tmux.sendText(session.tmuxName, rest.join(" "), { enter: !options.noEnter });
  ui.info(`sent to ${session.name}`);
}

function cmdCheck(config, options, ui) {
  const tmux = makeTmux(config, options);
  const problems = [];
  const notes = [];
  const seenCwd = new Map();

  for (const session of config.sessions) {
    context: {
      if (!existsSync(session.cwd)) {
        problems.push(`"${session.name}": cwd does not exist: ${session.cwd}`);
        break context;
      }
      if (!statSync(session.cwd).isDirectory()) {
        problems.push(`"${session.name}": cwd is not a directory: ${session.cwd}`);
        break context;
      }
      if (session.pi) {
        const exe = resolveExecutable(session.agent[0]);
        if (exe === session.agent[0] && !existsSync(session.agent[0])) {
          problems.push(`"${session.name}": agent "${session.agent[0]}" not found on PATH`);
        }
      }
      if (session.remotePiName) {
        const key = `${session.cwd}`;
        const prev = seenCwd.get(key);
        if (prev) notes.push(`"${session.name}" and "${prev.name}" share cwd ${key}`);
        else seenCwd.set(key, session);
      }
      if (session.enabled === false) {
        notes.push(`"${session.name}": enabled: false (skipped by bare "up"; start with up ${session.name})`);
      }
      if (session.remotePiMode === "config") {
        notes.push(`"${session.name}": writes ${remotePiConfigPath(session.cwd)}`);
      }
      if (session.piSession && !isSessionPath(session.piSession)) {
        notes.push(`"${session.name}": resumes pi session-id ${session.piSession} (created if missing)`);
      }
      if (session.piSession && isSessionPath(session.piSession) && !existsSync(session.piSession)) {
        notes.push(`"${session.name}": pi session file not found yet: ${session.piSession}`);
      }
    }
  }

  if (ui.json) {
    ui.out(JSON.stringify({ ok: problems.length === 0, problems, notes, config: config.path }, null, 2));
  } else {
    ui.out(`${ui.paint("bold", "config")} ${config.path}  ${ui.paint("dim", `${config.sessions.length} session(s)`)}`);
    for (const s of config.sessions) {
      ui.out(
        `  ${ui.paint("cyan", s.name)} → tmux:${s.tmuxName}  ${ui.paint("dim", s.cwd)}\n` +
          `    ${ui.paint("dim", describeSession(s))}`,
      );
    }
    for (const note of notes) ui.out(`  ${ui.paint("dim", "·")} ${note}`);
    if (problems.length) {
      for (const problem of problems) ui.error(problem);
    } else {
      ui.out(`\n${ui.paint("green", "ok")} config looks usable`);
    }
  }
  if (problems.length) process.exitCode = 1;
}

function commandExists(command) {
  const found = resolveExecutable(command);
  if (found !== command) return true;
  return command.includes("/") ? existsSync(found) : false;
}

function cmdDoctor(config, options, ui) {
  const tmux = makeTmux(config, options);
  const checks = [];
  const add = (label, ok, detail) => checks.push({ label, ok, detail });

  add("node", true, process.version);
  const tmuxVersion = (() => {
    try {
      return tmux.run(["-V"], { readOnly: true }).stdout.trim();
    } catch {
      return null;
    }
  })();
  add("tmux", Boolean(tmuxVersion), tmuxVersion ?? "not found");
  const hasServer = tmux.hasServer();
  add("tmux server", hasServer, hasServer ? "running" : "not running (will start on up)");
  add("pi", commandExists("pi"), resolveExecutable("pi"));
  add("config", Boolean(config), config?.path ?? "not found");
  const kind = autostartKind();
  add("autostart", Boolean(kind), kind ?? "unsupported platform");

  if (ui.json) {
    ui.out(JSON.stringify({ checks, warnings: config?.warnings ?? [] }, null, 2));
    return;
  }
  for (const check of checks) {
    const mark = check.ok ? ui.paint("green", "✓") : ui.paint("red", "✗");
    ui.out(`${mark} ${check.label.padEnd(14)} ${ui.paint("dim", check.detail ?? "")}`);
  }
  if (!config) ui.out(`\n${ui.paint("dim", "hint:")} no config found; run pi-farm init`);
  if (kind === "systemd") {
    ui.out(`\n${ui.paint("dim", "systemd unit dir:")} ${systemdUserDir()}`);
    ui.out(`${ui.paint("dim", "hint:")} systemctl --user status pi-farm`);
  } else if (kind === "darwin") {
    ui.out(`\n${ui.paint("dim", "launch agent:")} ${launchAgentPath()}`);
  }
  if (config?.warnings?.length) {
    ui.out("");
    for (const warning of config.warnings) ui.warn(warning);
  }
  if (checks.some((c) => !c.ok)) process.exitCode = 1;
}

function cmdInit(options, ui) {
  const target = options.path
    ? resolve(options.path)
    : options.local
      ? resolve("pi-farm.yml")
      : join(homedir(), ".pi", "farm.yml");
  if (existsSync(target) && !options.force) {
    ui.error(`${target} already exists (use --force to overwrite)`);
    process.exit(1);
  }
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, EXAMPLE_CONFIG, "utf8");
  ui.info(`wrote ${target}`);
  ui.info(`validate with: pi-farm check --config ${target}`);
  ui.info(`start with:    pi-farm up --config ${target}`);
}

function cmdInstall(config, options, ui) {
  const scriptPath = options.scriptPath ?? resolve(process.argv[1]);
  const watch = options.watch === true ? 300 : Number(options.watch) || 0;
  if (options.watch !== undefined && watch < 30) {
    ui.error("--watch interval must be at least 30 seconds");
    process.exit(2);
  }
  const result = installAutostart({
    scriptPath,
    configPath: config.path,
    watch,
    print: options.print,
    dryRun: options.dryRun,
  });
  if (options.print) return;
  if (ui.json) {
    ui.out(JSON.stringify(result, null, 2));
    return;
  }
  if (options.dryRun) {
    ui.info(`[dry-run] would install ${result.kind} autostart for ${config.path}`);
    return;
  }
  if (result.kind === "systemd") {
    ui.info(`installed ${result.servicePath}`);
    if (result.timerPath) ui.info(`installed ${result.timerPath}`);
    ui.info("enabled as a systemd user unit; sessions start at boot/login.");
    ui.info(ui.paint("dim", "If sessions should start before login: sudo loginctl enable-linger $USER"));
  } else {
    ui.info(`installed ${result.plistPath}`);
    ui.info("loaded as a launchd agent; sessions start at login.");
  }
}

function cmdUninstall(options, ui) {
  const result = uninstallAutostart({ dryRun: options.dryRun });
  if (ui.json) {
    ui.out(JSON.stringify(result, null, 2));
    return;
  }
  if (options.dryRun) {
    ui.info(`[dry-run] would remove ${result.removed.join(", ")}`);
    return;
  }
  ui.info(`removed ${result.removed.join(", ")}`);
}

export async function runCommand(command, options) {
  const ui = makeUi(options);
  if (options.json) ui.quiet = true;
  // Config warnings are only actionable for commands that act on the whole file.
  const warnCommands = new Set(["up", "start", "restart", "check", "validate", "doctor"]);
  if (!warnCommands.has(command)) options.showWarnings = false;
  switch (command) {
    case "up":
    case "start": {
      const config = requireConfig(options, ui);
      return cmdUp(config, options, ui);
    }
    case "down":
    case "stop": {
      const config = requireConfig(options, ui);
      return cmdDown(config, options, ui);
    }
    case "restart": {
      const config = requireConfig(options, ui);
      return cmdRestart(config, options, ui);
    }
    case "status":
    case "ls":
    case "list": {
      const config = requireConfig(options, ui);
      return cmdStatus(config, options, ui);
    }
    case "attach":
    case "a": {
      const config = requireConfig(options, ui);
      return cmdAttach(config, options, ui);
    }
    case "logs":
    case "log": {
      const config = requireConfig(options, ui);
      return cmdLogs(config, options, ui);
    }
    case "send": {
      const config = requireConfig(options, ui);
      return cmdSend(config, options, ui);
    }
    case "check":
    case "validate": {
      const config = requireConfig(options, ui);
      return cmdCheck(config, options, ui);
    }
    case "doctor": {
      let config = null;
      try {
        config = loadConfig({ configPath: options.config, cwd: options.cwd });
      } catch (err) {
        ui.error(err.message);
        process.exitCode = 2;
      }
      return cmdDoctor(config, options, ui);
    }
    case "init": {
      return cmdInit(options, ui);
    }
    case "install":
    case "autostart": {
      const config = requireConfig(options, ui);
      return cmdInstall(config, options, ui);
    }
    case "uninstall": {
      return cmdUninstall(options, ui);
    }
    default:
      ui.error(`unknown command: ${command}`);
      process.exit(2);
  }
}

export { EXAMPLE_CONFIG };
