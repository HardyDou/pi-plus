import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { homedir } from "node:os";
import {
  buildSessionArgv,
  describeSession,
  isSessionPath,
  expandPath,
  loadConfig,
  resolve,
  splitCommand,
  resolveSessionRef,
  shellQuote,
} from "./config.js";
import { readRemotePiConfig, remotePiConfigPath, writeRemotePiName } from "./remote-pi.js";
import { resolveExecutable, Tmux } from "./tmux.js";
import {
  installAutostart,
  uninstallAutostart,
  autostartKind,
  autostartState,
  describeAutostart,
  isWsl,
  launchAgentPath,
  systemdUserDir,
} from "./autostart.js";
import { clearStopped, isStopped, markStopped } from "./state.js";
import { findCommand, suggestCommand } from "./help.js";
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
      "no config found. Run `pp init` or pass --config <path>.\n" +
        "Looked for: ./pi-plus.yml, ~/.pi/plus.yml, $XDG_CONFIG_HOME/pi-plus/config.yml",
    );
    process.exit(2);
  }
  if (!ui.quiet && options.showWarnings !== false) {
    for (const warning of config.warnings ?? []) ui.warn(warning);
  }
  return config;
}

function selectSessions(config, names, ui, { all = false, options = null } = {}) {
  if (!names || names.length === 0) {
    if (all) return config.sessions;
    // Compose-style: `restart: no` is never part of a bare `up`/`restart`, and
    // a reconcile pass also honours sessions stopped by hand.
    return config.sessions.filter(
      (s) => s.restart !== "no" && !(options?.reconcile && isStopped(config.path, s.name)),
    );
  }
  const picked = [];
  for (const name of names) {
    const session = resolveSessionRef(config, name);
    if (!session) {
      const hint = `${config.sessions.length} session(s) configured; see pp ls`;
      ui.error(`unknown session "${name}" (${hint})`);
      process.exit(2);
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
  // pipe-pane writes with `cat >> '<path>'`; a missing parent dir would silently swallow
  // the log, so create it up front (matters on boot, where ~/.pi/plus/logs may not exist).
  if (session.log && !dryRun) {
    mkdirSync(dirname(session.log), { recursive: true });
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

export const SAFE_TMUX_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export function tmuxSafeName(raw) {
  const cleaned = String(raw)
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned || "session";
}

/** Build an ad-hoc (config-less) session for `pp new`. */
function adHocSession({ name, cwd, agent, log, remotePiName, remotePiMode }) {
  const argv = splitCommand(agent);
  const pi = basename(argv[0] ?? "") === "pi";
  return {
    name,
    tmuxName: name,
    cwd,
    agent: argv,
    pi,
    piSession: null,
    piSessionDir: null,
    piSessionName: pi ? name : null,
    remotePiName,
    remotePiMode,
    env: {},
    args: [],
    log,
    remainOnExit: false,
    restart: "always",
  };
}

async function cmdNew(baseConfig, options, ui) {
  const cwd = resolve(expandPath(options.dir ?? process.cwd()));
  if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
    ui.error(`directory does not exist: ${cwd}`);
    process.exit(2);
  }

  const explicitName = options.names[0];
  let name = tmuxSafeName(explicitName ?? basename(cwd));
  if (!SAFE_TMUX_NAME.test(name)) {
    ui.error(`invalid session name "${name}": use letters, digits, "-" and "_"`);
    process.exit(2);
  }

  const tmux = makeTmux(baseConfig ?? { tmuxSocket: null }, options);
  const live = tmux.listSessions();
  if (live.has(name)) {
    if (explicitName && !options.force) {
      ui.error(`tmux session "${name}" already exists (--force to recreate, or pick another name)`);
      process.exit(2);
    }
    if (!options.force) {
      let suffix = 2;
      while (live.has(`${name}-${suffix}`)) suffix += 1;
      ui.info(ui.paint("dim", `${name} is taken, using ${name}-${suffix}`));
      name = `${name}-${suffix}`;
    }
  }

  const agent = options.agent ?? "pi";
  const log = options.log ? join(homedir(), ".pi", "plus", "logs", `${name}.log`) : null;
  const remotePiName = options.noRemotePi ? null : name;
  const session = adHocSession({
    name,
    cwd,
    agent,
    log,
    remotePiName,
    // ad-hoc sessions never touch the project's remote-pi config file
    remotePiMode: "env",
  });

  // Where --save writes: the loaded config, else the file the user pointed at
  // explicitly (-c / PI_PLUS_CONFIG), else the default ~/.pi/plus.yml.
  const pointedAt = options.config ?? process.env.PI_PLUS_CONFIG;
  const savePath = baseConfig?.path ?? (pointedAt ? resolve(expandPath(pointedAt)) : join(homedir(), ".pi", "plus.yml"));
  const config = {
    path: savePath,
    tmuxSocket: baseConfig?.tmuxSocket ?? null,
    sessions: [session],
    warnings: [],
  };
  await cmdUp(config, { ...options, names: [], force: Boolean(options.force) }, ui);

  if (options.save) saveNewSession(config.path, session, ui);
  if (options.dryRun) return;

  if (options.attach && !process.stdout.isTTY) {
    ui.info(ui.paint("dim", "not a terminal: skipping attach"));
  } else if (options.attach) {
    if (!tmux.sessionExists(session.tmuxName)) {
      ui.error(`could not start "${session.name}"`);
      process.exit(1);
    }
    process.exit(tmux.attach(session.tmuxName));
  }
  if (!options.quiet) {
    ui.info(ui.paint("dim", `log or attach: pp logs ${session.name}  |  pp attach ${session.name}`));
  }
}

/** Append a `pp new` session to the config file (creating it when missing). */
export function saveNewSession(configPath, session, ui) {
  const entry = [
    `  - name: ${session.name}`,
    `    cwd: ${session.cwd}`,
    session.log ? `    log: ${session.log}` : null,
    session.remotePiName ? `    remote_pi_name: ${session.remotePiName}` : "    remote_pi_name: false",
    session.remotePiName ? "    remote_pi_mode: env" : null,
  ]
    .filter(Boolean)
    .join("\n");
  let body;
  if (existsSync(configPath)) {
    const text = readFileSync(configPath, "utf8");
    if (!/^sessions:\s*$/m.test(text)) {
      ui.error(`${configPath} has no "sessions:" section; add the session manually`);
      return;
    }
    body = `${text.replace(/\s*$/, "")}\n${entry}\n`;
  } else {
    mkdirSync(dirname(configPath), { recursive: true });
    body = `version: 1\nsessions:\n${entry}\n`;
  }
  writeFileSync(configPath, body, "utf8");
  ui.info(`saved to ${configPath}`);
}

async function cmdUp(config, options, ui) {
  const sessions = selectSessions(config, options.names, ui, { options });
  const tmux = makeTmux(config, options);
  const live = tmux.listSessions();
  // A session named on the command line is an explicit request: restart it even
  // when its policy is "no" and its pane is dead.
  const explicit = new Set(options.names ?? []);
  let started = 0;
  let skipped = 0;
  const failures = [];

  for (const session of sessions) {
    try {
      const entry = live.get(session.tmuxName);
      if (entry) {
        const dead = entry.panes.every((p) => p.dead);
        if (!dead && !options.force) {
          skipped++;
          ui.info(`${ui.paint("dim", "skip")}    ${session.tmuxName} ${ui.paint("dim", "(already running)")}`);
          continue;
        }
        const asked = explicit.has(session.name) || explicit.has(session.tmuxName);
        if (dead && session.restart === "no" && !asked) {
          skipped++;
          ui.info(
            `${ui.paint("dim", "skip")}    ${session.tmuxName} ${ui.paint("dim", "(dead; restart: no)")}`,
          );
          continue;
        }
        ui.info(`${ui.paint("yellow", dead ? "restart" : "recreate")} ${session.tmuxName}`);
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
      clearStopped(config.path, session.name);
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
    if (started && !options.dryRun) ui.info(`Attach with: pp attach ${sessions[0]?.name ?? "<name>"}`);
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
    // Compose semantics: "unless-stopped"/"on-failure" remember a manual stop.
    if (!options.reconcile && ["unless-stopped", "on-failure"].includes(session.restart)) {
      markStopped(config.path, session.name);
    }
    killed++;
    ui.info(`${ui.paint("red", "stopped")} ${session.tmuxName}`);
  }
  if (ui.json) ui.out(JSON.stringify({ killed, missing }, null, 2));
  else if (!options.quiet) ui.info(`\n${killed} stopped, ${missing} not running.`);
}

async function cmdRestart(config, options, ui) {
  const sessions = selectSessions(config, options.names, ui, { options });
  const tmux = makeTmux(config, options);
  for (const session of sessions) {
    if (tmux.sessionExists(session.tmuxName)) tmux.kill(session.tmuxName);
  }
  options.force = true;
  await cmdUp(config, { ...options, names: sessions.map((s) => s.name) }, ui);
}

function cmdStatus(config, options, ui) {
  // status lists every configured session, whatever its restart policy.
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
      index: config.sessions.indexOf(session) + 1,
      name: session.name,
      tmux: session.tmuxName,
      state: state === "stopped" && (session.restart === "no" || isStopped(config.path, session.name)) ? "off" : state,
      restart: session.restart,
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

  const headers = ["#", "NAME", "STATE", "RESTART", "PID", "AGENT", "CWD", "PI SESSION", "REMOTE-PI"];
  const table = rows.map((r) => [
    String(r.index),
    r.name,
    r.state,
    r.restart,
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
    colored[0] = ui.paint("dim", colored[0]);
    if (row.state === "off") colored[2] = ui.paint("dim", "off");
    const color = row.state === "running" ? "green" : row.state === "attached" ? "cyan" : row.state === "dead" ? "red" : "dim";
    colored[2] = ui.paint(color, colored[2]);
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
    ui.error("usage: pp attach <name>");
    process.exit(2);
  }
  const [session] = selectSessions(config, [name], ui);
  const tmux = makeTmux(config, options);
  if (options.dryRun) {
    ui.info(`[dry-run] tmux attach-session -t =${session.tmuxName}`);
    return;
  }
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
    ui.error("usage: pp logs <name> [--lines N]");
    process.exit(2);
  }
  const [session] = selectSessions(config, [name], ui);
  const tmux = makeTmux(config, options);
  if (options.dryRun) {
    ui.info(`[dry-run] tmux capture-pane -p -t =${session.tmuxName}: -S -${options.lines ?? 200}`);
    return;
  }
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
    ui.error('usage: pp send <name> "text" [--no-enter]');
    process.exit(2);
  }
  const [session] = selectSessions(config, [name], ui);
  const tmux = makeTmux(config, options);
  const text = rest.join(" ");
  if (options.dryRun) {
    ui.info(`[dry-run] tmux send-keys -t =${session.tmuxName}: -- ${shellQuote(text)}${options.noEnter ? "" : " Enter"}`);
    return;
  }
  if (!tmux.sessionExists(session.tmuxName)) {
    ui.error(`session "${session.name}" is not running`);
    process.exit(1);
  }
  tmux.sendText(session.tmuxName, text, { enter: !options.noEnter });
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
      // Only worth a note when the name is persisted per directory: in env mode
      // two sessions in one directory are perfectly fine.
      if (session.remotePiName && session.remotePiMode === "config") {
        const key = `${session.cwd}`;
        const prev = seenCwd.get(key);
        if (prev) notes.push(`"${session.name}" and "${prev.name}" share cwd ${key}`);
        else seenCwd.set(key, session);
      }
      if (session.restart === "no") {
        notes.push(`"${session.name}": restart: no (not started by bare "up"; start with up ${session.name})`);
      } else if (isStopped(config.path, session.name)) {
        notes.push(`"${session.name}": stopped by hand (restart: ${session.restart}); autostart will skip it`);
      }
      if (session.remotePiName && session.remotePiMode === "config") {
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
  // A missing server is normal (tmux starts on demand) — not a failure.
  add("tmux server", true, hasServer ? "running" : "not running (starts on demand)");
  add("pi", commandExists("pi"), resolveExecutable("pi"));
  add("config", Boolean(config), config?.path ?? "not found");
  const autostart = autostartState();
  add("autostart", Boolean(autostart.kind) && autostart.installed && autostart.enabled, describeAutostart(autostart));
  if (isWsl()) {
    // On WSL the distro only runs after Windows starts it; systemd alone cannot help.
    add("wsl", true, "Windows 侧需触发（任务计划/启动项），见 pp install 提示");
  }

  if (ui.json) {
    ui.out(JSON.stringify({ checks, warnings: config?.warnings ?? [] }, null, 2));
    return;
  }
  for (const check of checks) {
    const mark = check.ok ? ui.paint("green", "✓") : ui.paint("red", "✗");
    ui.out(`${mark} ${check.label.padEnd(14)} ${ui.paint("dim", check.detail ?? "")}`);
  }
  if (!config) ui.out(`\n${ui.paint("dim", "hint:")} no config found; run pp init`);
  if (autostart.kind === "systemd") {
    ui.out(`\n${ui.paint("dim", "systemd unit dir:")} ${systemdUserDir()}`);
    ui.out(`${ui.paint("dim", "hint:")} systemctl --user status pi-plus`);
  } else if (autostart.kind === "darwin") {
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
      ? resolve("pi-plus.yml")
      : join(homedir(), ".pi", "plus.yml");
  if (existsSync(target) && !options.force) {
    ui.error(`${target} already exists (use --force to overwrite)`);
    process.exit(1);
  }
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, EXAMPLE_CONFIG, "utf8");
  ui.info(`wrote ${target}`);
  ui.info(`validate with: pp check --config ${target}`);
  ui.info(`start with:    pp up --config ${target}`);
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
    ui.info(`\n[dry-run] nothing written; would install ${result.kind} autostart for ${config.path}`);
    return;
  }
  if (result.kind === "systemd") {
    ui.info(`installed ${result.servicePath}`);
    if (result.timerPath) ui.info(`installed ${result.timerPath}`);
    ui.info("enabled as a systemd user unit; sessions start at boot/login.");
    ui.info(ui.paint("dim", "If sessions should start before login: sudo loginctl enable-linger $USER"));
    if (isWsl()) {
      ui.info("");
      ui.info(ui.paint("yellow", "WSL: Windows 侧还需要一次触发，否则重启后 WSL 发行版根本不会启动。"));
      ui.info("  在 PowerShell（无需管理员）里执行，把 <发行版> 换成 wsl -l -v 里的名字:");
      ui.info('    $p = "$env:APPDATA\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\pi-plus.vbs"');
      ui.info('    Set-Content -Encoding ASCII $p \'Set s = CreateObject("WScript.Shell") : s.Run "wsl.exe -d <发行版> -u user -e /bin/true", 0, False\'');
      ui.info(ui.paint("dim", "  之后开机登录 Windows 即触发；WSL 启动后 systemd 会按 restart 策略把会话拉起来。"));
    }
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
    case "new":
    case "create":
    case "n": {
      let config = null;
      try {
        config = loadConfig({ configPath: options.config, cwd: options.cwd });
      } catch {
        config = null; // `pp new` works without any config file
      }
      return cmdNew(config, options, ui);
    }
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
    default: {
      const suggestion = suggestCommand(command);
      const canonical = suggestion ? (findCommand(suggestion)?.name ?? suggestion) : null;
      ui.error(`unknown command: ${command}`);
      if (canonical && canonical !== command) ui.error(`did you mean 'pp ${canonical}'?`);
      else ui.error("run 'pp help' to see the command list");
      process.exit(2);
    }
  }
}

export { EXAMPLE_CONFIG };
