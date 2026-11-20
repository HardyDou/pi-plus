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
import { clearPanel, findPanelPane, loadPanel, savePanel } from "./panel.js";
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
import {
  buildSchedule,
  describeSchedule,
  DEFAULT_CATCH_UP_SECONDS,
  CronError,
  cronLogPath,
  formatDuration,
  jobsPath,
  newJobId,
  nextRun,
  parseDuration,
  readJobs,
  removeJob,
  resetJob,
  tick as cronTick,
  writeJobs,
} from "./cron.js";
import {
  blockStatus as crondBlockStatus,
  CrondError,
  installBlock as installCrondBlock,
  readCrontab,
  renderBlock as renderCrondBlock,
  uninstallBlock as uninstallCrondBlock,
} from "./crond.js";
import { findCommand, suggestCommand } from "./help.js";
import { EXAMPLE_CONFIG } from "./example.js";
import {
  addTodo,
  agoString,
  clearTodos,
  filterTodos,
  readTodos,
  removeTodo,
  resolveTodo,
  setTodoState,
  todoRow,
  TodoError,
} from "./todo.js";
import { computeLayout, createTui, parseLeftOption, renderFrame } from "./tui.js";

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

function tryLoadConfig(options) {
  try {
    return loadConfig({ configPath: options.config, cwd: options.cwd });
  } catch (err) {
    if (options.config) throw err;
    return null;
  }
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
function printTodos(config, options, ui) {
  let live = new Map();
  try {
    live = makeTmux(config, options).listSessions();
  } catch {
    live = new Map();
  }
  const todos = filterTodos(readTodos(), { session: options.session ?? null, all: options.all });
  if (ui.json) {
    ui.out(JSON.stringify(todos.map((todo) => todoRow(todo)), null, 2));
    return;
  }
  if (!todos.length) {
    const hint = options.all ? "nothing has been recorded yet" : "nothing needs you right now";
    ui.info(`${hint} — pi records a todo when a session shows a prompt or ends on a question`);
    return;
  }
  const records = todos.map((todo) => todoRow(todo, { live }));
  const headers = ["#", "STATE", "WAITED", "SESSION", "KIND", "WHAT"];
  const table = records.map((row, index) => [
    String(index + 1),
    row.state,
    row.age,
    row.session,
    row.kind,
    `${row.title}${row.live === false ? "  (offline)" : ""}`,
  ]);
  const widths = headers.map((header, i) => Math.max(header.length, ...table.map((row) => row[i].length)));
  const pad = (value, width) => value + " ".repeat(Math.max(0, width - value.length));
  ui.out(ui.paint("bold", headers.map((h, i) => pad(h, widths[i])).join("  ").trimEnd()));
  table.forEach((row) => {
    const cells = row.map((value, i) => pad(value, widths[i]));
    const state = row[1] === "new" ? "bold" : "dim";
    cells[1] = pad(ui.paint(state, row[1]), widths[1] + (ui.color ? ui.paint(state, row[1]).length - row[1].length : 0));
    ui.out(cells.join("  ").trimEnd());
  });
  ui.info("open one with: pp todo attach <#>   finish it with: pp todo done <#>");
}

async function cmdTodoAdd(options, ui) {
  const text = options.names.join(" ").trim();
  if (!text) {
    ui.error('usage: pp todo add "what needs doing" [--session <name|#>]');
    process.exit(2);
  }
  let session = options.session ?? null;
  if (!session || session === "current") {
    const config = tryLoadConfig(options);
    // Only guess from tmux when we are actually inside a pane; outside it,
    // `display-message -p '#S'` answers with whatever the server used last.
    session = process.env.TMUX ? (currentTmuxSession(tmuxSocketOfEnv()) ?? null) : null;
    if (!session && config) {
      const running = config.sessions.filter((item) => {
        try {
          return makeTmux(config, options).sessionExists(item.tmuxName);
        } catch {
          return false;
        }
      });
      if (running.length === 1) session = running[0].tmuxName;
    }
  }
  if (!session) {
    ui.error("which session is this todo for? pass --session <name> (pp ls lists them)");
    process.exit(2);
  }
  const { todo, created } = addTodo({ session, kind: "manual", title: text }, process.env);
  if (ui.json) {
    ui.out(JSON.stringify(todoRow(todo), null, 2));
    return;
  }
  ui.info(`${created ? "added" : "still open"} #${todo.id} ${session}: ${todo.title}`);
}

function todoRefs(rest, ui, usage) {
  if (!rest.length) {
    ui.error(usage);
    process.exit(2);
  }
  return rest;
}

async function cmdTodoAttach(config, refs, options, ui) {
  const todos = readTodos();
  const todo = resolveTodo(todos, refs[0]).todo;
  setTodoState(todos, todo, "seen");
  const name = todo.session;
  const known = config?.sessions.find((item) => item.name === name || item.tmuxName === name) ?? null;
  if (known) {
    return cmdAttach(config, { ...options, names: [known.name] }, ui);
  }
  const tmux = makeTmux(config, options);
  if (!tmux.sessionExists(name)) {
    ui.error(`session "${name}" is not running (starting it is up to the config that owns it)`);
    process.exit(1);
  }
  if (options.dryRun) {
    ui.info(`[dry-run] tmux attach-session -t =${name}`);
    return;
  }
  process.exit(tmux.attach(name));
}

async function cmdTodo(config, options, ui) {
  const rest = [...options.names];
  const sub = rest.shift() ?? "ls";
  try {
    switch (sub) {
      case "ls":
      case "list":
        return printTodos(config, options, ui);
      case "add":
      case "note":
        return cmdTodoAdd({ ...options, names: rest }, ui);
      case "done":
      case "finish": {
        const refs = todoRefs(rest, ui, "usage: pp todo done <#>");
        const todos = readTodos();
        const done = refs.map((ref) => resolveTodo(todos, ref).todo);
        for (const todo of done) setTodoState(todos, todo, "done");
        ui.info(done.length === 1 ? `done #${done[0].id} ${done[0].session}` : `done ${done.length} todos`);
        return;
      }
      case "seen": {
        const refs = todoRefs(rest, ui, "usage: pp todo seen <#>");
        const todos = readTodos();
        const seen = refs.map((ref) => resolveTodo(todos, ref).todo);
        for (const todo of seen) setTodoState(todos, todo, "seen");
        ui.info(`marked ${seen.length} todo(s) seen`);
        return;
      }
      case "attach":
      case "go": {
        const refs = todoRefs(rest, ui, "usage: pp todo attach <#>");
        return cmdTodoAttach(config, refs, options, ui);
      }
      case "rm":
      case "remove":
      case "delete": {
        const refs = todoRefs(rest, ui, "usage: pp todo rm <#>");
        let todos = readTodos();
        const gone = refs.map((ref) => resolveTodo(todos, ref).todo);
        for (const todo of gone) todos = removeTodo(todos, todo);
        ui.info(`removed ${gone.length} todo(s)`);
        return;
      }
      case "clear":
      case "prune": {
        const removed = clearTodos({ doneOnly: !options.force });
        ui.info(
          removed === 0
            ? "nothing to clear"
            : `cleared ${removed} ${options.force ? "todo(s)" : "finished todo(s)"}${options.force ? "" : " (add --force to drop open ones too)"}`,
        );
        return;
      }
      default:
        ui.error(`unknown todo subcommand: ${sub}`);
        ui.info("usage: pp todo [ls | add | done | seen | attach | rm | clear]");
        process.exit(2);
    }
  } catch (err) {
    if (err instanceof TodoError) {
      ui.error(err.message);
      process.exit(2);
    }
    throw err;
  }
}

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

/** Rows for the sessions panel: config entries first, then live strays. */
function tuiSessionRows(config, live) {
  const rows = [];
  const seen = new Set();
  const stateOf = (entry) => {
    if (!entry) return "off";
    if (entry.panes?.length && entry.panes.every((pane) => pane.dead)) return "dead";
    return entry.attached ? "attached" : "running";
  };
  for (const session of config?.sessions ?? []) {
    seen.add(session.tmuxName);
    const entry = live.get(session.tmuxName) ?? null;
    const state = stateOf(entry);
    rows.push({
      name: session.tmuxName,
      state,
      label: `${String(config.sessions.indexOf(session) + 1).padStart(2)} ${session.tmuxName}  ${state}`,
      dim: state === "off" || state === "dead",
    });
  }
  for (const [name, entry] of live) {
    if (seen.has(name)) continue;
    const state = stateOf(entry);
    rows.push({ name, state, label: ` - ${name}  ${state} (not in config)`, dim: true });
  }
  return rows;
}

function tuiTodoRows(todos, now) {
  return todos.map((todo, index) => ({
    name: todo.session,
    ref: todo.id,
    label: `${index + 1}. ${todo.session} — ${todo.title} (${agoString(todo.createdAt, now)}, ${todo.kind})`,
    dim: todo.state === "done" || todo.state === "seen",
  }));
}

/**
 * The pane's real size, straight from tmux.
 *
 * Over ssh (and after a client resize) `process.stdout.rows` can lag behind the
 * pane, and a frame one row too tall scrolls the terminal — which looks exactly
 * like the panel appending a fresh frame every second. tmux is the authority.
 */
function tmuxPaneSize(tmux) {
  if (!process.env.TMUX) return null;
  const target = process.env.TMUX_PANE ? ["-t", process.env.TMUX_PANE] : [];
  const res = tmux.run(
    ["display-message", "-p", ...target, "#{pane_width} #{pane_height} #{client_width} #{client_height}"],
    { allowFailure: true, readOnly: true },
  );
  if (res.status !== 0) return null;
  const [cols, rows, clientCols, clientRows] = String(res.stdout ?? "")
    .trim()
    .split(/\s+/)
    .map((value) => Number(value) || 0);
  if (!cols || !rows) return null;
  // a tmux window can be larger than the client looking at it (window-size
  // largest/manual): then everything below the client's height is off-screen
  // and tmux lets you scroll to it, which is exactly the "it still scrolls"
  // report. Paint only what one client can actually see.
  return {
    cols,
    rows,
    clientCols: clientCols || 0,
    clientRows: clientRows || 0,
    visibleCols: Math.min(cols, clientCols || cols),
    visibleRows: Math.min(rows, clientRows || rows),
  };
}

async function cmdTui(config, options, ui) {
  const tmux = makeTmux(config, options);
  const once = Boolean(options.once);
  let leftWidth = 0;
  if (options.left !== undefined) {
    try {
      leftWidth = parseLeftOption(options.left, process.stdout.columns || 100);
    } catch (err) {
      ui.error(err.message);
      process.exit(2);
    }
  }


  if (!process.stdout.isTTY && !once) {
    ui.error("pp tui needs a terminal (try `pp tui --once` to print one frame)");
    process.exit(2);
  }

  const readLive = () => {
    try {
      return tmux.listSessions();
    } catch {
      return new Map();
    }
  };

  if (once) {
    const cols = process.stdout.columns || 100;
    const rows = process.stdout.rows || 30;
    const layout = computeLayout(cols, rows, { leftWidth });
    const live = readLive();
    const model = {
      sessions: tuiSessionRows(config, live),
      todos: tuiTodoRows(filterTodos(readTodos()), Date.now()),
      preview: { title: "—", lines: [] },
      focus: "sessions",
      footer: " pp tui --once  (--left 30 adjusts the sessions column) ",
    };
    for (const line of renderFrame(model, layout)) ui.out(line);
    return;
  }

  let paneCache = { at: 0, size: null };
  const paneSize = () => {
    const now = Date.now();
    if (now - paneCache.at > 1000) paneCache = { at: now, size: tmuxPaneSize(tmux) };
    return paneCache.size;
  };
  const screenSize = () => {
    const cols = process.stdout.columns || 100;
    const rows = process.stdout.rows || 30;
    const pane = paneSize();
    if (!pane) return { cols, rows };
    return { cols: Math.min(cols, pane.visibleCols), rows: Math.min(rows, pane.visibleRows) };
  };

  const previewLines = () => Math.max(4, computeLayout(screenSize().cols, screenSize().rows).preview.h - 2);

  let tui = null;
  tui = createTui({
    version: options.version ?? "",
    leftWidth,
    io: {
      input: process.stdin,
      output: process.stdout,
      isTTY: Boolean(process.stdin.isTTY),
      size: screenSize,
      onResize: (callback) => process.stdout.on("resize", callback),
      async refresh({ index = 0 } = {}) {
        const live = readLive();
        const sessions = tuiSessionRows(config, live);
        const todos = tuiTodoRows(filterTodos(readTodos()), Date.now());
        const current = sessions[index]?.name ?? sessions[0]?.name;
        let preview = { title: "—", lines: ["no session selected"] };
        if (current && live.has(current)) {
          const text = tmux.capture(current, previewLines());
          preview = { title: current, lines: text ? text.split("\n") : ["(empty pane)"] };
        }
        return { sessions, todos, preview };
      },
      async closeTodo(item) {
        const todos = readTodos();
        try {
          setTodoState(todos, resolveTodo(todos, item.ref).todo, "done");
        } catch {
          // a vanished todo is not worth an error in the middle of a redraw
        }
      },
      async attach(name) {
        if (!tmux.sessionExists(name)) {
          // no ui.warn here: printing into a live alt screen tears the frame
          tui?.noteFromAttach(`${name} is not running — start it with pp up ${name}`);
          await new Promise((resolve) => setTimeout(resolve, 600));
          return;
        }
        if (process.env.TMUX) {
          const clients = tmux.listClients?.() ?? [];
          const client = clients.sort((a, b) => b.activity - a.activity)[0];
          tmux.run(
            client
              ? ["switch-client", "-c", client.name, "-t", `=${name}`]
              : ["switch-client", "-t", `=${name}`],
            { allowFailure: true },
          );
          return;
        }
        tmux.attach(name);
      },
    },
  });
  if (process.env.TMUX) {
    const probe = tmux.run(["display-message", "-p", "#{session_name}\t#{window_index}\t#{pane_id}"], {
      allowFailure: true,
      readOnly: true,
    });
    const [session, window, pane] = String(probe.stdout ?? "").trim().split("\t");
    if (session) savePanel({ session, window, pane });
  }
  await tui.start();
}

async function cmdTuiDiag(config, options, ui) {
  const tmux = makeTmux(config, options);
  const inTmux = Boolean(process.env.TMUX);
  const tty = { cols: process.stdout.columns || 0, rows: process.stdout.rows || 0 };
  const pane = tmuxPaneSize(tmux);
  const target = process.env.TMUX_PANE ? ["-t", process.env.TMUX_PANE] : [];
  const probe = inTmux
    ? tmux.run(["display-message", "-p", ...target, "#{alternate_on} #{history_size} #{window_width}x#{window_height}"], {
        allowFailure: true,
        readOnly: true,
      })
    : { status: 1, stdout: "" };
  const [altOn = "?", history = "?", window = "?"] = String(probe.stdout ?? "").trim().split(/\s+/);
  const screen = pane
    ? { cols: Math.min(tty.cols || pane.visibleCols, pane.visibleCols), rows: Math.min(tty.rows || pane.visibleRows, pane.visibleRows) }
    : { cols: tty.cols || 100, rows: tty.rows || 30 };
  const layout = computeLayout(screen.cols, screen.rows, {
    leftWidth: options.left === undefined ? 0 : parseLeftOption(options.left, screen.cols),
    todoCount: readTodos().length,
  });

  ui.out(`pp ${options.version ?? ""} — pp tui --diag`);
  ui.out("");
  ui.out(`  tty            ${tty.cols}x${tty.rows}   TERM=${process.env.TERM ?? "?"}`);
  ui.out(
    inTmux
      ? `  inside tmux    yes (pane ${process.env.TMUX_PANE ?? "?"}, window ${window})`
      : "  inside tmux    no (the tty size is all there is)",
  );
  if (pane) {
    ui.out(`  pane size      ${pane.cols}x${pane.rows}   client sees ${pane.visibleCols}x${pane.visibleRows}`);
  } else {
    ui.out("  pane size      unavailable");
  }
  if (inTmux) {
    ui.out(
      `  alternate      on=${altOn}   history=${history} rows   ${
        altOn === "1" ? "(the panel owns the screen)" : "(no alternate screen: old frames stay in scrollback)"
      }`,
    );
  }
  ui.out(
    `  layout         ${layout.mode} — sessions ${layout.sessions.w}x${layout.sessions.h}, todo ${layout.todos.h} rows, preview ${layout.preview.h} rows`,
  );
  ui.out(`  frame          ${layout.height} rows x ${layout.width} cols, painted into ${screen.rows} rows`);
  ui.out(
    layout.height <= screen.rows
      ? "  verdict        fits — the panel cannot scroll the terminal"
      : `  verdict        OVERFLOW by ${layout.height - screen.rows} rows — this would scroll; report these numbers`,
  );
  if (pane && pane.rows > pane.visibleRows) {
    ui.out("");
    ui.out(
      `  note           this tmux window is ${pane.rows} rows but the client only shows ${pane.visibleRows};`,
    );
    ui.out("                 tmux will let you scroll the rest. Fix the window, not the panel:");
    ui.out("                 tmux set -g window-size latest   (or re-attach from the size you want)");
  }
}

/**
 * `pp back` — put this client in front of the panel it was launched from.
 *
 * The panel records its own session/window/pane when it starts (`panel.json`),
 * so coming back from a session you attached out of it is one command instead of
 * "Ctrl-b s and find the window". If the panel died in the meantime the record is
 * dropped and you are told, rather than being switched to a stranger's window.
 */
async function cmdBack(config, options, ui) {
  const tmux = makeTmux(config, options);
  const panel = loadPanel();
  if (!panel) {
    ui.error("no panel remembered — start one with: pp tui");
    process.exit(1);
  }
  const list = tmux.run(["list-panes", "-a", "-F", "#{pane_id} #{session_name} #{window_index}"], {
    allowFailure: true,
    readOnly: true,
  });
  const found = list.status === 0 ? findPanelPane(list.stdout, panel) : null;
  if (!found) {
    clearPanel();
    ui.error(`the panel in ${panel.session} is gone — start a new one with: pp tui`);
    process.exit(1);
  }
  if (options.dryRun) {
    ui.info(`[dry-run] tmux switch-client -t =${found.session} && select-window -t =${found.session}:${found.window}`);
    return 0;
  }
  if (process.env.TMUX) {
    // switch-client is the whole point: no detach, so the terminal never has to
    // restore a saved screen (which is what leaves a screenful behind).
    const res = tmux.run(["switch-client", "-t", `=${found.session}`], { allowFailure: true });
    if (res.status !== 0) {
      ui.error(String(res.stderr ?? "").trim() || "could not switch client");
      process.exit(1);
    }
    tmux.run(["select-window", "-t", `=${found.session}:${found.window}`], { allowFailure: true });
    if (found.pane) tmux.run(["select-pane", "-t", found.pane], { allowFailure: true });
    ui.info(`back at the panel — ${found.session}:${found.window}`);
    return 0;
  }
  process.exit(tmux.attach(found.session));
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


// -------------------------------------------------------------------- pp cron

function tmuxSocketOfEnv(env = process.env) {
  const raw = env.TMUX;
  if (!raw) return null;
  const parts = raw.split(",");
  return parts.length >= 3 ? parts.slice(0, parts.length - 2).join(",") : null;
}

function currentTmuxSession(socket) {
  const args = [...(socket ? ["-L", socket] : []), "display-message", "-p", "#S"];
  const result = spawnSync("tmux", args, { encoding: "utf8" });
  if (result.status !== 0) return null;
  const name = (result.stdout ?? "").trim();
  return name || null;
}

function refreshCronLog(options, ui) {
  // Honour the ui's own quiet flag: `--json` silences info lines so stdout stays
  // parseable (the model-facing `schedule` tool does JSON.parse on it).
  if (!ui.quiet && !options.quiet) ui.info(ui.paint("dim", `log: ${cronLogPath()}`));
}

/** Deliver one job: type the prompt into its pane, or run its command. */
function deliverJob(job, options) {
  if (job.action === "command") {
    const result = spawnSync("sh", ["-c", job.command], { encoding: "utf8" });
    if (result.error) return { status: `failed: ${result.error.message}` };
    if (result.status !== 0) return { status: `failed: exit ${result.status}` };
    return { status: "delivered" };
  }

  const tmux = new Tmux({ socket: job.socket ?? null });
  if (!tmux.sessionExists(job.session)) {
    if (!job.startSession) {
      return { status: `skipped: session "${job.session}" is not running` };
    }
    const args = [scriptPath(options), "up", job.session];
    if (job.configPath) args.push("--config", job.configPath);
    if (job.socket) args.push("--socket", job.socket);
    args.push("--quiet");
    spawnSync(process.execPath, args, { encoding: "utf8" });
    if (!tmux.sessionExists(job.session)) {
      return { status: `skipped: session "${job.session}" is not running (pp up failed)` };
    }
  }
  const send = spawnSync(
    "tmux",
    [...(job.socket ? ["-L", job.socket] : []), "send-keys", "-t", `=${job.session}:`, "-l", "--", job.prompt],
    { encoding: "utf8" },
  );
  if (send.status !== 0) return { status: `failed: tmux send-keys: ${(send.stderr ?? "").trim()}` };
  const enter = spawnSync(
    "tmux",
    [...(job.socket ? ["-L", job.socket] : []), "send-keys", "-t", `=${job.session}:`, "Enter"],
    { encoding: "utf8" },
  );
  if (enter.status !== 0) return { status: `failed: tmux send-keys Enter: ${(enter.stderr ?? "").trim()}` };
  return { status: "delivered" };
}

/** Local wall-clock stamp: `2026-11-21 09:00` (the timezone cron jobs run in). */
function localStamp(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function cronRow(job, now = new Date()) {
  const due = nextRun(job, now);
  return {
    id: job.id,
    session: job.action === "command" ? `$ ${job.command}` : job.session,
    schedule: describeSchedule(job.schedule),
    next: due ? localStamp(due) : "-",
    runs: job.runs ?? 0,
    last: job.lastStatus ?? "-",
  };
}

function printCronJobs(jobs, ui, now = new Date()) {
  if (!jobs.length) {
    ui.info("no scheduled jobs — add one with: pp cron add --at \"2026-11-21T09:00\" \"check the build\"");
    return;
  }
  const records = jobs.map((job) => cronRow(job, now));
  const headers = ["ID", "TARGET", "SCHEDULE", "NEXT", "RUNS", "LAST"];
  const table = records.map((row) => [row.id, row.session, row.schedule, row.next, String(row.runs), row.last]);
  const widths = headers.map((h, i) => Math.max(h.length, ...table.map((row) => row[i].length)));
  const pad = (value, width) => value + " ".repeat(Math.max(0, width - value.length));
  ui.out(ui.paint("bold", headers.map((h, i) => pad(h, widths[i])).join("  ").trimEnd()));
  table.forEach((row) => {
    const colored = [...row];
    colored[0] = ui.paint("dim", colored[0]);
    colored[3] = ui.paint("cyan", colored[3]);
    ui.out(colored.map((cell, index) => pad(cell, widths[index])).join("  ").trimEnd());
  });
}

async function cmdCronAdd(config, options, ui) {
  const text = options.names.join(" ").trim();
  const command = options.command;
  if (!text && !command) throw new CronError('nothing to say at that time — pass the prompt: pp cron add --at ... "check the build"');
  if (text && command) throw new CronError("give either a prompt or --command, not both");

  const schedule = buildSchedule({ at: options.in ? new Date(Date.now() + parseDuration(options.in, { what: "--in" }) * 1000).toISOString() : options.at, every: options.every, cron: options.cronExpr });

  let session = null;
  let socket = options.socket ?? config?.tmuxSocket ?? null;
  let configPath = config?.path ?? null;
  if (!command) {
    const wanted = options.session ?? null;
    if (wanted) {
      if (!config) {
        session = wanted;
      } else {
        const resolved = resolveSessionRef(config, wanted);
        if (resolved) {
          session = resolved.tmuxName;
        } else {
          // a session that is simply running (started by hand or by `pp new`)
          // is a fine target too: all the tick needs is a name that exists.
          let live = new Map();
          try {
            live = makeTmux(config, options).listSessions();
          } catch {
            live = new Map();
          }
          if (!live.has(wanted)) {
            throw new CronError(`unknown session "${wanted}" — not in ${config.path} and not running in tmux (pp ls lists both)`);
          }
          session = wanted;
        }
      }
    } else {
      const live = currentTmuxSession(tmuxSocketOfEnv());
      session = live ?? (config?.sessions.length === 1 ? config.sessions[0].tmuxName : null);
      if (!session) {
        throw new CronError("which session? pass --session <name|#> (running inside tmux would have answered this)");
      }
    }
  }

  const jobs = readJobs();
  const job = {
    id: newJobId(jobs),
    action: command ? "command" : "prompt",
    ...(command ? { command } : { prompt: text, session, socket }),
    schedule,
    catchUp: options.catchUp ? parseDuration(options.catchUp, { what: "--catch-up" }) : DEFAULT_CATCH_UP_SECONDS,
    startSession: Boolean(options.start),
    configPath,
    createdAt: new Date().toISOString(),
    runs: 0,
  };

  const due = nextRun(job);
  if (options.dryRun) {
    ui.out(`[dry-run] would schedule ${job.id}: ${describeSchedule(schedule)} → ${job.action === "command" ? `$ ${command}` : `session ${session}`}`);
    ui.out(`[dry-run] first run ${due ? due.toISOString() : "never"}`);
    return;
  }

  jobs.push(job);
  writeJobs(jobs);
  if (ui.json) {
    ui.out(JSON.stringify({ id: job.id, schedule: describeSchedule(schedule), next: due ? due.toISOString() : null, session }, null, 2));
    refreshCronLog(options, ui);
    return;
  }
  ui.info(`${ui.paint("green", "scheduled")} ${job.id}  ${describeSchedule(schedule)}  →  ${job.action === "command" ? `$ ${command}` : `session ${session}`}`);
  ui.info(ui.paint("dim", `first run: ${due ? due.toLocaleString() : "never"}   cancel with: pp cron rm ${job.id}`));
  if (!options.start && job.action === "prompt") {
    ui.info(ui.paint("dim", `the session must be running at that moment (add --start to bring it up first)`));
  }
  refreshCronLog(options, ui);
}

async function cmdCronList(config, options, ui) {
  let jobs = readJobs();
  if (options.names.length) {
    const ids = new Set(options.names);
    jobs = jobs.filter((job) => ids.has(job.id));
  }
  if (ui.json) {
    ui.out(JSON.stringify(jobs.map((job) => cronRow(job)), null, 2));
    return;
  }
  printCronJobs(jobs, ui);
  refreshCronLog(options, ui);
}

async function cmdCronRemove(config, options, ui) {
  if (!options.names.length) throw new CronError("which job? pp cron rm <id> (pp cron ls lists them)");
  let removed = 0;
  for (const id of options.names) {
    if (options.dryRun) {
      ui.out(`[dry-run] would remove ${id}`);
      continue;
    }
    const jobs = readJobs();
    const job = jobs.find((entry) => entry.id === id);
    if (!job) {
      ui.error(`no job "${id}"`);
      process.exitCode = 2;
      continue;
    }
    removeJob(id);
    removed += 1;
    ui.info(`removed ${id}  ${ui.paint("dim", `(${describeSchedule(job.schedule)})`)}`);
  }
  if (!options.dryRun && removed && !options.quiet) ui.info(ui.paint("dim", `${removed} job(s) removed`));
}

async function cmdCronRun(config, options, ui) {
  if (!options.names.length) throw new CronError("which job? pp cron run <id>");
  for (const id of options.names) {
    const jobs = readJobs();
    const job = jobs.find((entry) => entry.id === id);
    if (!job) {
      ui.error(`no job "${id}"`);
      process.exitCode = 2;
      continue;
    }
    if (options.dryRun) {
      ui.out(`[dry-run] would deliver ${id} → ${job.action === "command" ? `$ ${job.command}` : job.session}`);
      continue;
    }
    const result = deliverJob(job, options);
    job.lastAttempt = new Date().toISOString();
    job.lastStatus = result.status;
    if (result.status === "delivered") job.runs = (job.runs ?? 0) + 1;
    writeJobs(readJobs().map((entry) => (entry.id === id ? job : entry)));
    const paint = result.status === "delivered" ? "green" : "yellow";
    ui.info(`${ui.paint(paint, result.status)} ${id}`);
  }
}

async function cmdCronTick(config, options, ui) {
  const now = options.now ? new Date(options.now) : new Date();
  if (Number.isNaN(now.getTime())) throw new CronError(`--now "${options.now}" is not a date`);
  const result = cronTick({
    now,
    dryRun: Boolean(options.dryRun),
    deliver: (job) => deliverJob(job, options),
  });
  if (result.skipped && result.total === undefined) {
    if (!options.quiet) ui.info(ui.paint("dim", "another tick is running; skipped"));
    return;
  }
  if (ui.json) {
    ui.out(JSON.stringify(result, null, 2));
    return;
  }
  if (!options.quiet) {
    ui.info(`${result.ran.length} delivered, ${result.skipped.length} skipped, ${result.total} job(s) left`);
  }
}

function crondState() {
  try {
    const text = readCrontab();
    return crondBlockStatus(text);
  } catch (error) {
    return { installed: false, error: error.message };
  }
}

async function cmdCronInstall(config, options, ui) {
  const scriptPathValue = scriptPath(options);
  const via = options.via ?? "crond";
  if (via === "systemd") throw new CronError("systemd timers are not used for cron jobs; pp cron install writes a crontab line (--via crond)");
  const env = { PATH: process.env.PATH ?? "" };
  const logPath = options.log ?? cronLogPath();

  if (options.print) {
    ui.out(renderCrondBlock({ scriptPath: scriptPathValue, logPath, env }));
    return;
  }
  if (options.dryRun) {
    const crontab = readCrontab();
    ui.out(ui.paint("dim", `[dry-run] crontab is ${crontab ? `${crontab.split("\n").length} line(s)` : "empty"}; block would be:`));
    ui.out(renderCrondBlock({ scriptPath: scriptPathValue, logPath, env }));
    return;
  }

  const result = installCrondBlock({ scriptPath: scriptPathValue, logPath, env });
  if (ui.json) {
    ui.out(JSON.stringify({ installed: true, changed: result.changed, lines: crondBlockStatus(result.crontab).lines }, null, 2));
    return;
  }
  ui.info(`${result.changed ? ui.paint("green", "installed") : "already installed"} the pp crontab block  ${ui.paint("dim", "(crond runs `pp cron tick` every minute)")}`);
  ui.info(ui.paint("dim", `log: ${logPath}`));
  if (!crondState().installed) ui.info(ui.paint("yellow", "note: crontab still shows no block — check `crontab -l`"));
}

async function cmdCronUninstall(config, options, ui) {
  if (options.dryRun) {
    const state = crondState();
    ui.out(state.installed ? "[dry-run] would remove the pp crontab block" : "[dry-run] no pp crontab block");
    return;
  }
  const result = uninstallCrondBlock();
  if (!options.quiet) {
    ui.info(result.removed ? "removed the pp crontab block" : "no pp crontab block to remove");
  }
}

async function cmdCronStatus(config, options, ui) {
  const state = crondState();
  const jobs = readJobs();
  const now = new Date();
  const due = jobs
    .map((job) => ({ job, at: nextRun(job, now) }))
    .filter((row) => row.at)
    .sort((a, b) => a.at - b.at);
  if (ui.json) {
    ui.out(JSON.stringify({ crond: state, jobs: jobs.length, next: due[0] ? { id: due[0].job.id, at: due[0].at.toISOString() } : null }, null, 2));
    return;
  }
  const tickLine = state.error ? ui.paint("red", state.error) : state.installed ? ui.paint("green", "installed (pp cron tick every minute)") : ui.paint("yellow", "not installed — pp cron install");
  ui.info(`crond   ${tickLine}`);
  ui.info(`jobs    ${jobs.length}${due[0] ? ui.paint("dim", `   next: ${due[0].job.id} at ${due[0].at.toLocaleString()}`) : ""}`);
  ui.info(ui.paint("dim", `store   ${jobsPath()}`));
  ui.info(ui.paint("dim", `log     ${cronLogPath()}`));
}

async function cmdCronLogs(config, options, ui) {
  const path = cronLogPath();
  if (!existsSync(path)) {
    ui.info(`no cron log yet (${path})`);
    return;
  }
  const lines = readFileSync(path, "utf8").trimEnd().split("\n");
  const count = options.lines ?? 20;
  ui.out(lines.slice(-count).join("\n"));
}

async function cmdCron(config, options, ui) {
  const rest = [...options.names];
  const sub = rest.shift();
  const takeArg = (name) => {
    const index = rest.indexOf(name);
    if (index === -1) return null;
    const value = rest[index + 1];
    if (!value) throw new CronError(`${name} needs a value`);
    rest.splice(index, 2);
    return value;
  };

  if (!sub) {
    return cmdCronStatus(config, options, ui);
  }
  const restOptions = { ...options };
  switch (sub) {
    case "add":
    case "at": {
      const at = takeArg("--at") ?? (options.at ?? null);
      const every = takeArg("--every") ?? (options.every ?? null);
      const cronExpr = takeArg("--cron") ?? (options.cronExpr ?? null);
      const inText = takeArg("--in") ?? (options.in ?? null);
      const session = takeArg("--session") ?? (options.session ?? null);
      const command = takeArg("--command") ?? (options.command ?? null);
      const catchUp = takeArg("--catch-up") ?? (options.catchUp ?? null);
      const orUndef = (value) => (value === null || value === "" ? undefined : value);
      return cmdCronAdd(
        config,
        {
          ...restOptions,
          names: rest,
          at: orUndef(at),
          every: orUndef(every),
          cronExpr: orUndef(cronExpr),
          in: orUndef(inText),
          session: orUndef(session),
          command: orUndef(command),
          catchUp: orUndef(catchUp),
        },
        ui,
      );
    }
    case "ls":
    case "list":
      return cmdCronList(config, { ...restOptions, names: rest }, ui);
    case "rm":
    case "remove":
    case "delete":
      return cmdCronRemove(config, { ...restOptions, names: rest }, ui);
    case "run":
    case "fire":
      return cmdCronRun(config, { ...restOptions, names: rest }, ui);
    case "tick":
      return cmdCronTick(config, restOptions, ui);
    case "install":
      return cmdCronInstall(config, restOptions, ui);
    case "uninstall":
      return cmdCronUninstall(config, restOptions, ui);
    case "status":
      return cmdCronStatus(config, restOptions, ui);
    case "logs":
    case "log":
      return cmdCronLogs(config, restOptions, ui);
    case "reset": {
      for (const id of rest) {
        if (!resetJob(id)) {
          ui.error(`no job "${id}"`);
          process.exitCode = 2;
        } else {
          ui.info(`reset ${id}`);
        }
      }
      return;
    }
    default:
      throw new CronError(`unknown cron subcommand: ${sub} (add, ls, rm, run, tick, install, uninstall, status, logs)`);
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
    case "cron": {
      let config = null;
      try {
        config = loadConfig({ configPath: options.config, cwd: options.cwd });
      } catch (err) {
        if (options.config) {
          ui.error(err.message);
          process.exit(2);
        }
        config = null;
      }
      return cmdCron(config, options, ui);
    }
    case "todo":
    case "todos": {
      let config = null;
      try {
        config = loadConfig({ configPath: options.config, cwd: options.cwd });
      } catch (err) {
        if (options.config) {
          ui.error(err.message);
          process.exit(2);
        }
        config = null;
      }
      return cmdTodo(config, options, ui);
    }
    case "back":
      return cmdBack(tryLoadConfig(options), options, ui);
    case "tui":
    case "panel":
      return options.diag ? cmdTuiDiag(tryLoadConfig(options), options, ui) : cmdTui(tryLoadConfig(options), options, ui);
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
