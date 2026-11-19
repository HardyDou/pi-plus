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
  removeSessionFromFile,
  shellQuote,
} from "./config.js";
import { readRemotePiConfig, remotePiConfigPath, writeRemotePiName } from "./remote-pi.js";
import {
  addAlias,
  aliasDir,
  BUILTIN_NAMES,
  AliasError,
  describeCommandNames,
  dirOnPath,
  inspectCommandNames,
  listAliases,
  removeAlias,
} from "./aliases.js";
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
import {
  compareVersions,
  fetchLatestVersion,
  installKind,
  packageRoot,
  planUpdate,
  readManifest,
  UpdateError,
} from "./update.js";
import { spawnSync } from "node:child_process";
import {
  BROADCAST_TARGET,
  connectPeer,
  describeEnvelope,
  livePeersFor,
  MeshError,
  peerPc,
  probePeers,
  sessionMeshAddress,
} from "./mesh.js";
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

/** Ask a yes/no question on the terminal (only used when stdin is a TTY). */
async function confirmOnTerminal(question) {
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(question)).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

/**
 * `pp rm` — kill the tmux session(s) and delete their entries from the config.
 * `pp down` only stops them; this is the destructive one, so it asks first
 * (or demands --force when there is no terminal to ask on).
 */
async function cmdRm(config, options, ui) {
  // never sweep: a bare `pp rm` would delete the whole farm by accident
  if (!options.names.length) {
    ui.error("nothing to remove — name the session(s): pp rm <name|#> (pp ls lists them)");
    process.exitCode = 2;
    return;
  }
  const sessions = selectSessions(config, options.names, ui, { all: false });
  if (!sessions.length) {
    ui.error("nothing to remove — name the session(s): pp rm <name|#>");
    process.exitCode = 2;
    return;
  }

  const tmux = makeTmux(config, options);
  const live = tmux.listSessions();
  const target = sessions.map((session) => ({
    session,
    running: live.has(session.tmuxName),
  }));
  const names = target.map((row) => row.session.tmuxName).join(", ");

  if (!options.force && !options.dryRun) {
    if (!process.stdin.isTTY) {
      ui.error(`refusing to delete ${names} without --force (removes the tmux session and its config entry)`);
      process.exitCode = 2;
      return;
    }
    const ok = await confirmOnTerminal(
      `delete ${names}? the tmux session and its entry in ${config.path} both go away [y/N] `,
    );
    if (!ok) {
      ui.info("cancelled");
      return;
    }
  }

  let killed = 0;
  let removed = 0;
  for (const { session, running } of target) {
    const label = options.dryRun ? "would remove" : "removed";
    if (running && !options.dryRun) {
      tmux.kill(session.tmuxName);
      killed += 1;
    }
    clearStopped(config.path, session.name);
    const dropEntry = Boolean(config.path) && !options.noConfig;
    const gone = dropEntry ? (options.dryRun ? true : removeSessionFromFile(config.path, session.name)) : false;
    if (gone) removed += 1;
    const bits = [
      running ? "tmux session" : "no tmux session",
      dropEntry ? (gone ? "config entry" : "no config entry") : "config entry kept",
    ];
    ui.info(`${ui.paint("red", label)} ${session.tmuxName}  ${ui.paint("dim", `(${bits.join(", ")})`)}`);
  }

  if (ui.json) {
    ui.out(JSON.stringify({ killed, removed, sessions: target.map((row) => row.session.name) }, null, 2));
    return;
  }
  if (!options.quiet) {
    ui.info(`\n${options.dryRun ? "would remove" : "removed"} ${target.length} session(s): ${killed} killed, ${removed} config entr${removed === 1 ? "y" : "ies"} deleted.`);
    if (removed) ui.info(ui.paint("dim", `backup first next time: cp ${config.path} ${config.path}.bak`));
  }
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

function sessionForAddress(config, address) {
  if (!config) return null;
  for (const session of config.sessions) {
    const base = sessionMeshAddress(session);
    if (base && (address === base || address.startsWith(`${base}#`))) return session;
  }
  return null;
}

function meshUsage(ui) {
  ui.error('usage: pp mesh <ls|send|resolve> ...  (see "pp help mesh")');
  process.exit(2);
}

async function cmdMesh(config, options, ui) {
  const [sub, ...rest] = options.names;
  switch (sub) {
    case undefined:
    case "ls":
    case "list":
    case "peers":
      return cmdMeshLs(config, options, ui);
    case "send":
    case "msg":
      return cmdMeshSend(config, { ...options, names: rest }, ui);
    case "resolve":
    case "addr":
      return cmdMeshResolve(config, { ...options, names: rest }, ui);
    case "inbox":
    case "listen":
    case "watch":
      return cmdMeshInbox(config, { ...options, names: rest }, ui);
    default:
      ui.error(`unknown mesh subcommand: ${sub}`);
      return meshUsage(ui);
  }
}

async function cmdMeshLs(config, options, ui) {
  let peers;
  try {
    peers = await probePeers({ timeoutMs: options.wait ?? 3000 });
  } catch (err) {
    ui.error(err.message);
    process.exit(1);
  }
  const rows = peers.map((address, index) => {
    const session = sessionForAddress(config, address);
    return {
      index: index + 1,
      address,
      pc: peerPc(address),
      session: session ? session.name : null,
    };
  });
  if (ui.json) {
    ui.out(JSON.stringify(rows, null, 2));
    return;
  }
  if (rows.length === 0) {
    ui.info("no peers in the mesh");
    return;
  }
  const headers = ["#", "ADDRESS", "PC", "SESSION"];
  const table = rows.map((r) => [String(r.index), r.address, r.pc ?? "-", r.session ?? "-"]);
  const widths = headers.map((h, i) => Math.max(h.length, ...table.map((row) => row[i].length)));
  const pad = (value, width) => value + " ".repeat(Math.max(0, width - value.length));
  ui.out(ui.paint("bold", headers.map((h, i) => pad(h, widths[i])).join("  ").trimEnd()));
  table.forEach((row, i) => {
    const cells = [...row];
    cells[0] = ui.paint("dim", cells[0]);
    if (rows[i].session) cells[3] = ui.paint("green", cells[3]);
    ui.out(cells.map((cell, idx) => pad(cell, widths[idx])).join("  ").trimEnd());
  });
  if (!options.quiet) {
    const local = rows.filter((r) => !r.pc).length;
    ui.out(`\n${rows.length} peer(s): ${local} local, ${rows.length - local} cross-PC`);
  }
}

async function cmdMeshResolve(config, options, ui) {
  if (!config) {
    ui.error("no config found; cannot resolve session names (use a raw mesh address instead)");
    process.exit(2);
  }
  const sessions = selectSessions(config, options.names, ui, { all: true });
  let peers = [];
  try {
    peers = await probePeers({ timeoutMs: options.wait ?? 3000 });
  } catch {
    peers = []; // resolving is useful offline; just report the offline state
  }
  const rows = sessions.map((session) => {
    const base = sessionMeshAddress(session);
    const live = livePeersFor(peers, base);
    return {
      name: session.name,
      address: base,
      online: live.length > 0,
      matches: live,
    };
  });
  if (ui.json) {
    ui.out(JSON.stringify(rows, null, 2));
    return;
  }
  for (const row of rows) {
    if (!row.address) {
      ui.out(`${row.name}: no remote-pi name (remote_pi_mode: off?)`);
      continue;
    }
    const state = row.online ? ui.paint("green", `online x${row.matches.length}`) : ui.paint("dim", "offline");
    ui.out(`${row.name} → ${row.address}  ${state}`);
    if (row.matches.length > 1) {
      for (const match of row.matches) ui.out(`  ${ui.paint("dim", match)}`);
    }
  }
}

async function cmdMeshInbox(config, options, ui) {
  const name = options.as ?? "pp-inbox";
  let peer;
  try {
    peer = await connectPeer({ name, cwd: options.cwd ?? process.cwd(), timeoutMs: options.wait ?? 5000 });
  } catch (err) {
    ui.error(err.message);
    process.exit(1);
  }
  let received = 0;
  let closing = false;
  const leave = (reason) => {
    if (closing) return;
    closing = true;
    try {
      peer.close();
    } catch {
      /* socket already gone */
    }
    if (reason === "signal") {
      if (!ui.json) ui.info(`left the mesh as ${peer.address} (${received} message(s))`);
      process.exit(0);
    }
  };
  const onBrokerFrame = (envelope) => {
    if (!ui.verbose) return;
    const event = envelope?.body ?? {};
    ui.out(ui.paint("dim", `${event.type ?? "event"}: ${event.address ?? event.name ?? "?"}`));
  };
  peer.onMessage((envelope) => {
    // The broker pushes its own lifecycle events as envelopes from "broker"
    // (peer_joined / peer_left); they are not messages for us.
    const eventType = envelope?.body?.type;
    if (envelope?.from === "broker" || eventType === "peer_joined" || eventType === "peer_left") {
      onBrokerFrame(envelope);
      return;
    }
    if (!envelope || eventType === "ack") return; // ACKs belong to senders
    received += 1;
    const message = describeEnvelope(envelope);
    if (ui.json) {
      ui.out(JSON.stringify(message));
      return;
    }
    const header = message.re ? `from ${message.from}  re=${message.re}` : `from ${message.from}`;
    ui.out(`${ui.paint("green", header)}`);
    for (const line of message.body.split("\n")) ui.out(`  ${line}`);
  });
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => leave("signal"));
  peer.socket.on("close", () => {
    if (closing) return;
    ui.error(`mesh connection closed by the broker (was ${peer.address})`);
    process.exitCode = 1;
    process.exit(1);
  });
  if (!ui.json) {
    const where = config?.path ? `  config: ${config.path}` : "";
    ui.out(`${ui.paint("green", `listening as ${peer.address}`)}${where}`);
    ui.out(ui.paint("dim", "Ctrl-C to leave; messages are printed as they arrive"));
  }
  // keep the process alive while the socket is open
  await new Promise(() => {});
}

async function cmdMeshSend(config, options, ui) {
  const hasBodyJson = options.bodyJson !== undefined;
  if (options.names.length < (hasBodyJson ? 1 : 2)) {
    ui.error('usage: pp mesh send <target...> "text" [--wait <ms>] [--reply <ms>] [--no-wait] [--body-json <json>]');
    process.exit(2);
  }
  const text = hasBodyJson ? null : options.names[options.names.length - 1];
  const rawTargets = hasBodyJson ? options.names : options.names.slice(0, -1);
  let body = text;
  if (hasBodyJson) {
    try {
      body = JSON.parse(options.bodyJson);
    } catch (err) {
      ui.error(`--body-json is not valid JSON: ${err.message}`);
      process.exit(2);
    }
  }

  // Resolve names/config first: then "unknown session" and a missing config are
  // reported before we bother the broker.
  const wanted = [];
  let broadcast = false;
  for (const raw of rawTargets) {
    if (raw === "all" || raw === "broadcast" || raw === "*") {
      broadcast = true;
      continue;
    }
    if (raw.includes("@") || /^[A-Za-z0-9._-]+:\//.test(raw)) {
      wanted.push({ kind: "address", value: raw });
      continue;
    }
    if (!config) {
      ui.error(`no config found; cannot resolve session "${raw}" (pass a full mesh address instead)`);
      process.exit(2);
    }
    const [session] = selectSessions(config, [raw], ui);
    const base = sessionMeshAddress(session);
    if (!base) {
      ui.error(`"${session.name}" has no remote-pi name (remote_pi_mode: off?)`);
      process.exit(2);
    }
    wanted.push({ kind: "session", value: base, session });
  }

  let peers = [];
  if (!options.dryRun || wanted.length > 0 || broadcast) {
    try {
      peers = await probePeers({ timeoutMs: options.wait ?? 3000 });
    } catch (err) {
      if (!(err instanceof MeshError) || err.code !== "no_broker") throw err;
      ui.error(err.message);
      process.exit(1);
    }
  }

  const targets = [];
  for (const item of wanted) {
    const live = livePeersFor(peers, item.value);
    if (live.length === 0) {
      if (item.kind === "address") ui.error(`no peer online at ${item.value}`);
      else ui.error(`"${item.session.name}" is not in the mesh yet (${item.value} is offline; is the session running?)`);
      process.exit(1);
    }
    targets.push(...live);
  }

  const unique = [...new Set(targets)];
  const multicast = broadcast || unique.length > 1;
  if (!broadcast && unique.length === 0) {
    ui.error("no targets");
    process.exit(2);
  }
  if (options.dryRun) {
    const envelope = { from: options.as ?? "pp-mesh", to: broadcast ? BROADCAST_TARGET : multicast ? unique : unique[0], body };
    ui.info(`[dry-run] ${JSON.stringify(envelope)}`);
    return;
  }

  let peer;
  try {
    peer = await connectPeer({ name: options.as ?? "pp-mesh", cwd: process.cwd() });
  } catch (err) {
    ui.error(err.message);
    process.exit(1);
  }
  let sendId = null;
  let waitingForFirstReply = null;
  const replies = [];
  const collecting = options.reply !== undefined && options.reply > 0;
  if (collecting) {
    peer.onMessage((envelope) => {
      if (!envelope || envelope.re !== sendId) return;
      replies.push(envelope);
      if (!ui.json) {
        ui.out(`${ui.paint("green", `reply from ${envelope.from}`)}: ${formatMeshBody(envelope.body)}`);
      }
      waitingForFirstReply?.();
      waitingForFirstReply = null;
    });
  }
  const collect = async (single = true) => {
    if (!collecting) return;
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, options.reply);
      if (!single) return;
      waitingForFirstReply = () => {
        clearTimeout(timer);
        resolve();
      };
    });
    waitingForFirstReply = null;
    if (ui.json) {
      ui.out(JSON.stringify(replies, null, 2));
      return replies.length;
    }
    if (replies.length === 0) ui.info(`no reply within ${options.reply}ms (the peer may still be working)`);
    return replies.length;
  };
  try {
    if (broadcast) {
      sendId = peer.send(BROADCAST_TARGET, body);
      ui.info(`broadcast to ${peers.length} peer(s) as ${peer.address} (${sendId})`);
      await collect(false);
      return;
    }
    if (multicast) {
      sendId = peer.send(unique, body);
      ui.info(`sent to ${unique.length} peer(s) as ${peer.address} (${sendId})`);
      for (const target of unique) ui.out(`  ${ui.paint("dim", target)}`);
      await collect(false);
      return;
    }
    const target = unique[0];
    if (options.noWait) {
      sendId = peer.send(target, body);
      ui.info(`sent to ${target} (${sendId})`);
      await collect();
      return;
    }
    const ack = await peer.sendWithAck(target, body, options.wait ?? 5000);
    sendId = ack.id;
    if (ack.status === "received") {
      ui.info(`delivered to ${target} (${ack.id})`);
      await collect();
      return;
    }
    if (ack.status === "busy") {
      ui.error(`${target} is mid-turn: broker dropped the message (busy). Retry later or use --no-wait.`);
      process.exitCode = 1;
      return;
    }
    if (ack.status === "denied") {
      ui.error(`delivery to ${target} was denied by the broker`);
      process.exitCode = 1;
      return;
    }
    ui.error(`no ACK from ${target} within ${options.wait ?? 5000}ms (the message may still arrive)`);
    process.exitCode = 1;
  } finally {
    peer.close();
  }
}

function formatMeshBody(body) {
  if (typeof body === "string") return body;
  try {
    return JSON.stringify(body);
  } catch {
    return String(body);
  }
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
  const names = inspectCommandNames({ target: scriptPath(options) });
  add("command name", names.ok, describeCommandNames(names));
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
  if (!names.ok) {
    ui.out(
      `${ui.paint("dim", "hint:")} another program owns the name on PATH; pick one with ` +
        `pp alias add pif  (or use pifarm / pi-plus) — see pp help alias`,
    );
  }
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

function scriptPath(options = {}) {
  return options.scriptPath ?? resolve(process.argv[1]);
}

function cmdInstall(config, options, ui) {
  const scriptPath_ = scriptPath(options);
  const watch = options.watch === true ? 300 : Number(options.watch) || 0;
  if (options.watch !== undefined && watch < 30) {
    ui.error("--watch interval must be at least 30 seconds");
    process.exit(2);
  }
  const result = installAutostart({
    scriptPath: scriptPath_,
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

async function cmdUpdate(options, ui) {
  const current = readManifest(packageRoot()).version;
  const info = installKind(scriptPath(options));
  const registry = options.registry ?? process.env.PP_NPM_REGISTRY ?? undefined;

  let latest = null;
  try {
    latest = await fetchLatestVersion(registry ? { registry } : undefined);
  } catch (error) {
    if (!(error instanceof UpdateError)) throw error;
    if (ui.json) ui.out(JSON.stringify({ current, latest: null, error: error.message }, null, 2));
    else ui.error(error.message);
    if (options.json) return;
    ui.info(ui.paint("dim", "hint: upgrade by hand: npm i -g pi-farm@latest"));
    process.exit(2);
  }

  const behind = compareVersions(latest, current) > 0;
  const plan = planUpdate({
    kind: info.kind,
    currentVersion: current,
    latestVersion: latest,
    registry: registry ?? "https://registry.npmjs.org",
    root: info.root,
    path: info.path,
  });

  if (options.json) {
    ui.out(
      JSON.stringify(
        { current, latest, upToDate: !behind, installKind: info.kind, command: plan ? [plan.command, ...plan.args] : null },
        null,
        2,
      ),
    );
    process.exitCode = behind ? 1 : 0;
    return;
  }

  if (!behind) {
    ui.info(`pi-farm ${current} is up to date (latest ${latest})`);
    return;
  }
  ui.info(`update available: ${current} → ${latest}  (${info.kind} install)`);
  if (!plan) {
    ui.error(`cannot tell how this copy was installed (${info.path})`);
    ui.info(ui.paint("dim", `upgrade by hand: npm i -g ${"pi-farm"}@${latest}`));
    process.exit(1);
  }
  const line = [plan.command, ...plan.args].join(" ");
  if (plan.note) ui.info(ui.paint("dim", `note: ${plan.note}`));

  if (options.check) {
    ui.info(ui.paint("dim", `would run: ${line}`));
    process.exitCode = 1; // 1 = "an update is available", handy for scripts
    return;
  }
  if (options.dryRun) {
    ui.info(`[dry-run] ${line}`);
    return;
  }

  ui.info(ui.paint("dim", `$ ${line}`));
  const result = spawnSync(plan.command, plan.args, { stdio: "inherit", cwd: plan.cwd ?? process.cwd() });
  if (result.error) {
    ui.error(`failed to run ${plan.command}: ${result.error.message}`);
    process.exit(1);
  }
  if (plan.kind === "git") {
    // A checkout upgraded in place: the running process is still the old code.
    ui.info(`pulled; restart pp to use ${latest}`);
    return;
  }
  const after = readManifest(packageRoot()).version;
  if (compareVersions(after, latest) >= 0) ui.info(`now pi-farm ${after}`);
  else if (result.status === 0) {
    ui.error(`npm finished but this copy is still ${after} (another pi-farm may shadow it: type -a pp)`);
    process.exitCode = 1;
  } else {
    process.exitCode = result.status ?? 1;
  }
}

function cmdAlias(config, options, ui) {
  const sub = options.names[0] ?? "ls";
  const rest = options.names.slice(1);
  const target = scriptPath(options);
  const dir = aliasDir(process.env, options.binDir);
  const onPath = dirOnPath(dir);

  const show = (payload) => {
    if (ui.json) {
      ui.out(JSON.stringify(payload, null, 2));
      return true;
    }
    return false;
  };

  try {
    switch (sub) {
      case "ls":
      case "list": {
        const aliases = listAliases({ dir, target });
        if (show({ dir, onPath, aliases })) return;
        if (aliases.length === 0) {
          ui.out(`no aliases in ${dir}`);
        } else {
          for (const alias of aliases) {
            ui.out(`${ui.paint("bold", alias.name.padEnd(12))} ${ui.paint("dim", alias.path)}`);
          }
        }
        ui.out(
          ui.paint(
            "dim",
            `${onPath ? "" : `note: ${dir} is not on PATH; `}built in: ${BUILTIN_NAMES.join(", ")}`,
          ),
        );
        ui.out(ui.paint("dim", "add one with: pp alias add pif"));
        return;
      }
      case "add":
      case "create":
      case "link": {
        const name = rest[0];
        assertAliasNameSafe(name);
        const result = addAlias(name, { dir, target, force: options.force });
        if (show({ ...result, dir, onPath })) return;
        ui.info(`${result.changed ? "linked" : "already linked"} ${result.path} → ${target}`);
        if (!onPath) {
          ui.info(ui.paint("yellow", `note: ${dir} is not on PATH; add it, e.g. export PATH="${dir}:$PATH"`));
        }
        ui.info(ui.paint("dim", `try: ${name} ls`));
        return;
      }
      case "rm":
      case "remove":
      case "delete":
      case "unlink": {
        const name = rest[0];
        assertAliasNameSafe(name);
        const removed = removeAlias(name, { dir, target });
        if (show({ name, removed, dir })) return;
        if (!removed) {
          ui.info(`nothing to remove at ${join(dir, name)}`);
          return;
        }
        ui.info(`removed ${join(dir, name)}`);
        return;
      }
      default:
        ui.error(`unknown alias subcommand: ${sub}`);
        ui.error("usage: pp alias [ls | add <name> | rm <name>] [--bin-dir <dir>]");
        process.exit(2);
    }
  } catch (err) {
    if (err instanceof AliasError) {
      ui.error(err.message);
      process.exit(err.code === "usage" ? 2 : 1);
    }
    throw err;
  }
}

function assertAliasNameSafe(name) {
  if (!name) {
    throw new AliasError("alias name is required, e.g. pp alias add pif", "usage");
  }
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
    case "rm":
    case "remove":
    case "delete": {
      const config = requireConfig(options, ui);
      return cmdRm(config, options, ui);
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
    case "mesh": {
      let config = null;
      try {
        config = loadConfig({ configPath: options.config, cwd: options.cwd });
      } catch {
        config = null; // raw addresses and `pp mesh ls` work without a config
      }
      return cmdMesh(config, options, ui);
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
    case "update":
    case "upgrade": {
      return cmdUpdate(options, ui);
    }
    case "alias":
    case "link": {
      return cmdAlias(null, options, ui); // aliasing does not need a config
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
