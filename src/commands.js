import { closeSync, existsSync, ftruncateSync, mkdirSync, openSync, readFileSync, readSync, statSync, writeFileSync, writeSync } from "node:fs";
import { configChanges } from "./configdiff.js";
import { basename, dirname, join } from "node:path";
import { homedir } from "node:os";
import {
  buildSessionArgv,
  describeSession,
  isSessionPath,
  expandPath,
  loadConfig,
  setSessionFieldInFile,
  resolve,
  splitCommand,
  resolveSessionRef,
  removeSessionFromFile,
  appendSessionBlock,
  NAME_RE,
  RESTART_POLICIES,
  renderSessionEntry,
  shellQuote,
} from "./config.js";
import { agoText, auditActor, auditPath, pruneAudit, readAudit, recordAudit, stateDir } from "./audit.js";
import { clearPanel, findPanelPane, loadPanel, panelAlive, savePanel } from "./panel.js";
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
import { hasEditor, looksBusy, resolveExecutable, screenSignature, Tmux } from "./tmux.js";
import {
  authSummary,
  DEFAULT_PORT,
  nodeTarget,
  normalizeNode,
  NodeError,
  parseProbe,
  parseSshConfig,
  PROBE_SCRIPT,
  removeNodeFromFile,
  renderNodeBlock,
  runOnNode,
  runOnNodeAsync,
  setNodeFieldInFile,
  sshInvocation,
  tightenConfigMode,
  upsertNodeInFile,
} from "./nodes.js";
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
import {
  activityOf,
  busySinceOf,
  clearActivity,
  clearBusy,
  clearStopped,
  isStopped,
  markBusy,
  markStopped,
  markRestart,
  markStarted,
  noteActivity,
  restartsOf,
  startedOf,
} from "./state.js";
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
  hasBlock as crondHasBlock,
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
import { computeLayout, createTui, parseLeftOption, renderFrame, stripAnsi } from "./tui.js";

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

/** Is this session protected by its machine's `guarded: true`? */
function guardOf(config, session) {
  if (!session?.node) return false;
  return Boolean((config.nodes ?? []).find((node) => node.name === session.node)?.guarded);
}

/**
 * A drained machine is under maintenance: nothing should start there until
 * somebody says otherwise, including autostart and `cron --heal`.
 */
function drainOf(config, session) {
  if (!session?.node) return false;
  return Boolean((config.nodes ?? []).find((node) => node.name === session.node)?.drained);
}

/** The nodes a `--tag` / `--node` selector picks out, or all of them. */
function taggedNodes(config, options = {}) {
  let nodes = config.nodes ?? [];
  if (options.node) nodes = nodes.filter((node) => node.name === options.node);
  const tags = options.tags ?? [];
  if (tags.length) nodes = nodes.filter((node) => tags.every((tag) => (node.tags ?? []).includes(tag)));
  return nodes;
}

function selectSessions(config, names, ui, { all = false, options = null, respectDrain = false } = {}) {
  // `--node <name>` narrows any batch command to one machine, so a broken host
  // can be restarted without touching the other 40 sessions.
  const onlyNode = options?.node;
  const onlyTags = options?.tags ?? [];
  if (onlyNode !== undefined && !(config.nodes ?? []).some((node) => node.name === onlyNode)) {
    ui.error(`no node "${onlyNode}" — see pp node ls`);
    process.exit(2);
  }
  for (const tag of onlyTags) {
    if (!(config.nodes ?? []).some((node) => (node.tags ?? []).includes(tag))) {
      ui.error(`no node is tagged "${tag}" — see pp node ls`);
      process.exit(2);
    }
  }
  const allowed =
    onlyNode === undefined && onlyTags.length === 0
      ? null
      : new Set(taggedNodes(config, { node: onlyNode, tags: onlyTags }).map((n) => n.name));
  const onNode = (list) => {
    const scoped = allowed === null ? list : list.filter((s) => s.node && allowed.has(s.node));
    // Starting something on a machine that is being worked on is the one thing
    // drain has to prevent — but `status`, `logs` and `rm` must still see it.
    if (!respectDrain || options?.force) return scoped;
    const drained = scoped.filter((s) => drainOf(config, s));
    if (!options?.quiet) {
      for (const session of drained) {
        ui.info(
          `${ui.paint("dim", "skip")}    ${session.tmuxName} ${ui.paint("dim", `(drained machine ${session.node}; pp node undrain ${session.node})`)}`,
        );
      }
    }
    return scoped.filter((s) => !drainOf(config, s));
  };
  if (!names || names.length === 0) {
    if (all) return onNode(config.sessions);
    // Compose-style: `restart: no` is never part of a bare `up`/`restart`, and
    // a reconcile pass also honours sessions stopped by hand.
    return onNode(
      config.sessions.filter(
        (s) => s.restart !== "no" && !(options?.reconcile && isStopped(config.path, s.name)),
      ),
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
  // Named sessions go through the same gates as a bare `pp up`: `--node` scoping
  // and drain. Forgetting this made `pp up web-01` happily start a drained box.
  return onNode(picked);
}

/** The node a session runs on (or null when it is local). */
function nodeForSession(config, session) {
  const name = typeof session === "string" ? session : session?.node;
  if (!name) return null;
  return (config?.nodes ?? []).find((node) => node.name === name) ?? null;
}

/** Sessions that point at one node. */
function sessionsOnNode(config, name) {
  return (config?.sessions ?? []).filter((session) => session.node === name);
}

/**
 * A tmux handle for `session`: local, or `ssh <node> tmux …` when the session
 * lives on a registered machine. Everything else in this file keeps working
 * unchanged, which is the point.
 */
function makeTmux(config, options, session = null) {
  const node = nodeForSession(config, session);
  return new Tmux({
    socket: options.socket ?? config?.tmuxSocket ?? null,
    dryRun: options.dryRun,
    verbose: options.verbose,
    remote: node ? { node } : null,
  });
}

function launchSpec(session, tmux) {
  const argv = buildSessionArgv(session);
  const remote = Boolean(session.node);
  // On a node the agent lives there: resolving the binary against this machine
  // would rewrite `pi` into /home/me/.nvm/.../pi, which does not exist remotely.
  if (!remote) argv[0] = resolveExecutable(argv[0]);
  const env = { ...session.env };
  if (session.remotePiName && session.remotePiMode === "env") {
    const base = remote ? {} : readRemotePiConfig(session.cwd);
    env.REMOTE_PI_DIRECT_CONFIG = JSON.stringify({ ...base, agent_name: session.remotePiName });
  }
  return { argv, env };
}

function prepareSession(session, { dryRun = false } = {}) {
  const remote = Boolean(session.node);
  if (remote) return; // cwd, log dir and remote-pi config live on the node itself
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
/**
 * One line in the audit trail. Never fails the command it describes, and never
 * records a dry run — a plan is not a change.
 */
function note(action, target, { detail = null, result = null, node = null, dryRun = false, skip = false } = {}) {
  if (dryRun || skip) return;
  recordAudit({ action, target, detail, result, node });
}

function readConfigText(path) {
  if (!path) return null;
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/**
 * Run a config write and record what it actually changed.
 *
 * The audit already says "pp node add p201"; the question people actually ask
 * later is "what did it change" — so diff the file around the write and keep the
 * first few field-level lines. Writes that change nothing record nothing.
 */
function auditedWrite({ config, action, target, node = null, dryRun = false }, write) {
  const before = dryRun ? null : readConfigText(config?.path);
  const result = write();
  if (dryRun || before === null) return result;
  const after = readConfigText(config.path);
  if (after === null || after === before) return result;
  const { total, lines } = configChanges(before, after);
  if (!total) return result;
  note(action, target, {
    node,
    detail: `${total} change${total === 1 ? "" : "s"}: ${lines.join("; ")}`,
    result: "changed",
  });
  return result;
}

function adHocSession({ name, cwd, agent, log, remotePiName, remotePiMode, node = null }) {
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
    node,
  };
}

async function cmdNew(baseConfig, options, ui) {
  // `--node` puts the session on another machine: the directory only has to
  // exist *there*, so leave the check to the remote tmux.
  let node = null;
  if (options.node) {
    node = (baseConfig?.nodes ?? []).find((entry) => entry.name === options.node);
    if (!node) {
      ui.error(`no node "${options.node}" — see pp node ls`);
      process.exit(2);
    }
  }
  let cwd = resolve(expandPath(options.dir ?? process.cwd()));
  if (node?.basePath && options.dir && !/^[~/]/.test(options.dir) && !/^\.\.?\//.test(options.dir)) {
    // "-C api" on a machine whose sessions live in /srv means /srv/api
    cwd = `${String(node.basePath).replace(/\/+$/, "")}/${options.dir.replace(/^\.\//, "")}`;
  }
  if (!node && (!existsSync(cwd) || !statSync(cwd).isDirectory())) {
    ui.error(`directory does not exist: ${cwd}`);
    process.exit(2);
  }

  const explicitName = options.names[0];
  let name = tmuxSafeName(explicitName ?? basename(cwd));
  if (!SAFE_TMUX_NAME.test(name)) {
    ui.error(`invalid session name "${name}": use letters, digits, "-" and "_"`);
    process.exit(2);
  }

  const tmux = makeTmux(baseConfig ?? { tmuxSocket: null, nodes: [] }, options, { node: node?.name ?? null });
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
    node: node?.name ?? null,
  });

  // Where --save writes: the loaded config, else the file the user pointed at
  // explicitly (-c / PI_PLUS_CONFIG), else the default ~/.pi/plus.yml.
  const pointedAt = options.config ?? process.env.PI_PLUS_CONFIG;
  const savePath = baseConfig?.path ?? (pointedAt ? resolve(expandPath(pointedAt)) : join(homedir(), ".pi", "plus.yml"));
  const config = {
    path: savePath,
    tmuxSocket: baseConfig?.tmuxSocket ?? null,
    nodes: baseConfig?.nodes ?? [],
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
    session.node ? `    node: ${session.node}` : null,
    session.log ? `    log: ${session.log}` : null,
    session.remotePiName ? `    remote_pi_name: ${session.remotePiName}` : "    remote_pi_name: false",
    session.remotePiName ? "    remote_pi_mode: env" : null,
  ]
    .filter(Boolean)
    .join("\n");
  let body;
  if (existsSync(configPath)) {
    let text = readFileSync(configPath, "utf8");
    if (/^sessions:\s*\[\s*\]\s*$/m.test(text)) {
      // an empty flow list is still an empty section, not a reason to give up
      text = text.replace(/^sessions:\s*\[\s*\]\s*$/m, "sessions:");
    }
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

/**
 * Move a session to another machine: stop it where it is, rewrite the one
 * `node:` line in the config, start it there. What it cannot move is the pi
 * conversation — that jsonl lives beside the old cwd — so say so out loud
 * instead of letting the next person wonder where their history went.
 */
async function cmdMv(config, options, ui) {
  const names = [...(options.names ?? [])].filter((name) => name !== undefined);
  if (names.length !== 1) {
    ui.error("usage: pp mv <session> --node <machine>   (or --local to bring it home)");
    process.exit(2);
  }
  const session = resolveSessionRef(config, names[0]);
  if (!session) {
    ui.error(`no session named "${names[0]}" — see pp ls`);
    process.exit(2);
  }
  const target = options.node ?? (options.local ? "" : null);
  if (target === null) {
    ui.error("say where it should run: --node <machine>, or --local to bring it back here");
    process.exit(2);
  }
  const from = session.node ?? "";
  const where = (name) => (name ? `on ${name}` : "here");
  if (target === from) {
    ui.error(`${session.name} already runs ${where(from)}`);
    process.exit(1);
  }

  let targetNode = null;
  if (target) {
    targetNode = findNode(config, target);
    if (!targetNode) {
      ui.error(`no node "${target}" — see: pp node ls`);
      process.exit(2);
    }
    const probe = makeTmux(config, options, { node: target });
    if (!probe.reachable()) {
      ui.error(`node "${target}" is unreachable — nothing was changed`);
      process.exit(1);
    }
    if (options.sessionCwd) {
      const check = runOnNode(targetNode, [`[ -d ${shellQuote(options.sessionCwd)} ] && echo yes || echo no`], { timeout: 15000 });
      if (check.stdout.trim() !== "yes") {
        ui.error(`${options.sessionCwd} does not exist on ${target} — create it first, or pass another --cwd`);
        process.exit(1);
      }
    }
  } else if (options.sessionCwd && !existsSync(options.sessionCwd)) {
    ui.error(`${options.sessionCwd} does not exist here`);
    process.exit(1);
  }

  const targetTmux = makeTmux(config, options, { node: target || null });
  if (targetTmux.sessionExists(session.tmuxName)) {
    if (!options.force) {
      ui.error(`a session named ${session.tmuxName} is already running ${where(target)} — stop it, or use --force`);
      process.exit(1);
    }
    if (!options.dryRun) targetTmux.kill(session.tmuxName);
    ui.info(`replaced the session already running ${where(target)}`);
  }

  const source = makeTmux(config, options, session);
  const running = source.sessionExists(session.tmuxName);
  if (options.dryRun) {
    ui.out(`[dry-run] tmux kill-session -t =${session.tmuxName} ${from ? `(via ${from})` : ""}`);
    ui.out(`[dry-run] ${config.path}: ${session.name}.node = ${target || "local"}`);
    if (options.sessionCwd) ui.out(`[dry-run] ${config.path}: ${session.name}.cwd = ${options.sessionCwd}`);
    ui.out(`[dry-run] pp up ${session.name} ${target ? `(via ${target})` : ""}`);
    return;
  }
  if (running) {
    source.kill(session.tmuxName);
    ui.info(`stopped ${session.tmuxName} ${where(from)}`);
  }

  const yamlValue = (value) => (/^[A-Za-z0-9._/~@%+-]+$/.test(value) ? value : JSON.stringify(value));
  auditedWrite({ config, action: "config.changed", target: session.name, dryRun: options.dryRun }, () => {
    setSessionFieldInFile(config.path, session.name, "node", target ? yamlValue(target) : null);
    if (options.sessionCwd) setSessionFieldInFile(config.path, session.name, "cwd", yamlValue(options.sessionCwd));
  });

  const fresh = loadConfig({ configPath: config.path, cwd: process.cwd() });
  const moved = fresh?.sessions.find((entry) => entry.name === session.name);
  if (!moved) {
    ui.error(`${session.name} vanished from ${config.path} after the edit — check the file`);
    process.exit(1);
  }
  await cmdUp(fresh, { ...options, names: [session.name], node: undefined, tags: undefined }, ui);
  note("mv", session.name, { detail: `${from || "local"} -> ${target || "local"}`, node: target || null });
  ui.info(`moved ${session.name}: ${from || "local"} -> ${target || "local"}`);
  if (moved.pi) {
    ui.info(
      `the pi conversation stays ${where(from)} — ${where(target)} starts a fresh one` +
        (options.sessionCwd && options.sessionCwd !== session.cwd ? " in the new cwd" : ""),
    );
  }
}

async function cmdUp(config, options, ui) {
  // --drift: only the sessions that are missing right now, then say what runs
  // that nobody wrote down. "walk the park and fix what is off", not "start all".
  let driftNames = null;
  if (options.drift) {
    const liveCache = new Map();
    const liveFor = (session) => {
      const key = session.node ?? "";
      if (!liveCache.has(key)) liveCache.set(key, makeTmux(config, options, session).listSessions());
      return liveCache.get(key);
    };
    const missing = [];
    for (const session of selectSessions(config, options.names, ui, { all: true, options, respectDrain: true })) {
      if (liveFor(session).has(session.tmuxName)) continue;
      if (isStopped(config.path, session.name) && !options.force) {
        ui.info(`${ui.paint("dim", "skip")}    ${session.tmuxName} ${ui.paint("dim", "(stopped by hand; --force starts it)")}`);
        continue;
      }
      missing.push(session.name);
    }
    const strays = [];
    for (const [key, map] of liveCache) {
      for (const name of map.keys()) {
        const onNode = config.sessions.some((session) => session.tmuxName === name && (session.node ?? "") === key);
        if (!onNode) strays.push(name);
      }
    }
    if (strays.length) {
      ui.warn(`${strays.length} running but not in the config: ${strays.join(", ")} — pp adopt ${strays.join(" ")}`);
    }
    if (missing.length === 0) {
      ui.info(`nothing to start — the config and ${strays.length ? "the machine" : "this machine"} agree`);
      return;
    }
    driftNames = missing;
    ui.info(`starting ${missing.length} missing: ${missing.join(", ")}`);
  }
  const sessions = driftNames
    ? config.sessions.filter((session) => driftNames.includes(session.name))
    : selectSessions(config, options.names, ui, { options, respectDrain: true });
  const liveCache = new Map();
  const liveFor = (session) => {
    const key = session.node ?? "";
    if (!liveCache.has(key)) liveCache.set(key, makeTmux(config, options, session).listSessions());
    return liveCache.get(key);
  };
  // A session named on the command line is an explicit request: restart it even
  // when its policy is "no" and its pane is dead.
  const explicit = new Set(options.names ?? []);
  let started = 0;
  let skipped = 0;
  const failures = [];

  for (const session of sessions) {
    try {
      const tmux = makeTmux(config, options, session);
      const entry = liveFor(session).get(session.tmuxName);
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
      const why = options.startedWhy ?? (options.reconcile ? "autostart" : "up");
      markStarted(config.path, session.name, { why, by: auditActor(process.env) });
      markRestart(config.path, session.name, { why, by: auditActor(process.env) });
      started++;
      ui.info(`${ui.paint("green", "started")} ${session.name} ${ui.paint("dim", `→ tmux:${session.tmuxName}  cwd:${session.cwd}`)}`);
      if (options.wait) {
        const asked = Number(options.wait) > 0 ? Number(options.wait) : 0;
        const fromEnv = Number(process.env.PP_READY_SECONDS ?? 0);
        const timeoutMs = (asked || fromEnv || 60) * 1000;
        const ready = await waitReady(tmux, session, { timeoutMs });
        if (ready.ready) {
          ui.info(`${ui.paint("green", "ready")} ${session.name} ${ui.paint("dim", `in ${ready.seconds}s — it will take a prompt now`)}`);
        } else {
          failures.push({ session: session.name, error: `not ready after ${ready.seconds}s (${ready.reason})` });
          ui.warn(`${session.name} is not ready after ${ready.seconds}s — ${ready.reason}; look: pp logs ${session.name}`);
        }
      }
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
  note("up", sessions.map((session) => session.name).join(","), {
    detail: `${started} started, ${skipped} already running${failures.length ? `, ${failures.length} failed` : ""}`,
    result: failures.length ? "partial" : "ok",
    dryRun: options.dryRun,
    skip: Boolean(options.skipAudit),
  });
  if (failures.length) process.exitCode = 1;
}

function cmdDown(config, options, ui) {
  // Stopping is always safe: a bare "down" stops everything, enabled or not.
  const picked = selectSessions(config, options.names, ui, { all: true, options });
  // `guarded: true` on the machine: stopping its sessions is deliberate work.
  // a drained machine is under maintenance: forcing (or the reconcile loop)
  // past that on someone else's box has to be said out loud, not implied by --force
  const lockedDrained = picked.filter(
    (session) => (options.force || options.reconcile) && !options.yes && drainOf(config, session),
  );
  const guarded = options.force || options.reconcile ? [] : picked.filter((session) => guardOf(config, session));
  const blocked = [...lockedDrained, ...guarded.filter((session) => !lockedDrained.includes(session))];
  const sessions = picked.filter(
    (session) => !lockedDrained.includes(session) && (options.force || options.reconcile || !guardOf(config, session)),
  );
  for (const session of lockedDrained) {
    ui.warn(
      `${session.tmuxName} runs on a drained machine (${session.node}) — maintenance window: add --yes to stop it anyway`,
    );
  }
  for (const session of guarded.filter((entry) => !lockedDrained.includes(entry))) {
    ui.warn(`${session.tmuxName} runs on a guarded machine — stop it with: pp down ${session.tmuxName} --force`);
  }
  let killed = 0;
  let missing = 0;
  for (const session of sessions) {
    const tmux = makeTmux(config, options, session);
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
  if (ui.json) ui.out(JSON.stringify({ killed, missing, blocked: blocked.length }, null, 2));
  else if (!options.quiet) {
    const why = [
      lockedDrained.length ? `${lockedDrained.length} needs --yes (drained machine)` : "",
      guarded.length ? `${guarded.length} blocked by a guard` : "",
    ].filter(Boolean).join(", ");
    ui.info(`\n${killed} stopped, ${missing} not running.${why ? ` ${why}.` : ""}`);
  }
  const drainedHit = sessions.some((session) => drainOf(config, session));
  note(drainedHit ? "down.forced" : "down", sessions.map((session) => session.name).join(","), {
    detail: `${killed} stopped, ${missing} not running${blocked.length ? `, ${blocked.length} guarded` : ""}`,
    detail: `${killed} stopped, ${missing} not running${blocked.length ? `, ${blocked.length} guarded` : ""}${drainedHit ? " (drained machine, --yes given)" : ""}`,
    result: options.force ? "force" : "ok",
    dryRun: options.dryRun,
  });
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
  const owner = (config?.sessions ?? []).find((item) => item.tmuxName === name || item.name === name);
  const tmux = makeTmux(config, options, owner);
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

/**
 * Adopt sessions that are already running but not in the config. A machine
 * tends to grow tmux sessions before anyone writes them down; this is the way
 * back to "what runs here is what is written here".
 */
async function cmdAdopt(config, options, ui) {
  if (options.restart && !RESTART_POLICIES.includes(options.restart)) {
    ui.error(`--restart must be one of ${RESTART_POLICIES.join(", ")} (got "${options.restart}")`);
    process.exitCode = 2;
    return;
  }
  const nodeName = options.node ? findNode(config, options.node).name : null;
  const node = nodeName ? nodeForSession(config, { node: nodeName }) : null;
  const tmux = makeTmux(config, options, nodeName ? { node: nodeName } : null);
  const live = tmux.listSessions();
  if (live.size === 0) {
    ui.info(`${tmux.label} has no running sessions to adopt`);
    return;
  }

  const configured = new Set(config.sessions.filter((session) => (session.node ?? null) === nodeName).map((session) => session.tmuxName));
  const byName = new Map(config.sessions.map((session) => [session.name, session]));
  const strays = [...live.values()].filter((entry) => !configured.has(entry.name)).sort((a, b) => a.name.localeCompare(b.name));
  if (strays.length === 0) {
    ui.info(`nothing to adopt on ${tmux.label} — all ${live.size} running session(s) are in the config`);
    return;
  }

  const wanted = (options.names ?? []).filter((name) => name !== undefined);
  const picked = wanted.length ? strays.filter((entry) => wanted.includes(entry.name)) : options.all ? strays : [];
  if (picked.length === 0) {
    const already = wanted.filter((name) => !strays.some((entry) => entry.name === name));
    if (wanted.length && already.length) {
      ui.info(`already in the config: ${already.join(", ")}`);
      return;
    }
    ui.error(`say which to adopt, or --all:  ${strays.map((entry) => entry.name).join(", ")}`);
    return;
  }
  if (!options.all) {
    const unknown = wanted.filter((name) => !live.has(name));
    if (unknown.length) ui.warn(`not running here: ${unknown.join(", ")}`);
  }

  const rows = [];
  for (const entry of picked) {
    const agent = (entry.panes.find((pane) => !pane.dead)?.command ?? "").trim();
    const problem =
      !NAME_RE.test(entry.name)
        ? `"${entry.name}" is not a valid session name — rename it or add it by hand`
        : byName.has(entry.name)
          ? `a session named "${entry.name}" is already configured${byName.get(entry.name).node ? ` on ${byName.get(entry.name).node}` : ""}`
          : live.get(entry.name).panes.every((pane) => pane.dead)
            ? "its pane is dead — nothing to adopt"
            : null;
    rows.push({
      entry,
      problem,
      session: {
        name: entry.name,
        cwd: entry.path,
        node: nodeName,
        agent: agent || DEFAULT_AGENT,
        restart: options.restart ?? "unless-stopped",
      },
    });
  }

  const good = rows.filter((row) => !row.problem);
  if (options.json) {
    ui.data(JSON.stringify(good.map((row) => ({ name: row.session.name, cwd: row.session.cwd, node: row.session.node, agent: row.session.agent })), null, 2));
  } else {
    const shells = new Set(["pi", "bash", "zsh", "sh", "dash", "fish", "node", "python3", "python", "tmux"]);
    for (const row of rows) {
      if (row.problem) ui.warn(`${row.session.name}: ${row.problem}`);
      else {
        ui.out(`  + ${row.session.name}  ${row.session.cwd}  agent:${row.session.agent}${row.session.node ? `  node:${row.session.node}` : ""}`);
        if (!shells.has(row.session.agent.split(" ")[0])) ui.warn(`  ${row.session.name}: agent "${row.session.agent}" is what the pane is running — pass --agent to record something else`);
      }
    }
  }
  if (good.length === 0) {
    ui.error("nothing could be adopted");
    process.exitCode = 1;
    return;
  }
  if (options.dryRun) {
    ui.info(`[dry-run] would write ${good.length} session(s) to ${config.path}`);
    for (const row of good) ui.out(renderSessionEntry(row.session));
    return;
  }

  let text = readFileSync(config.path, "utf8");
  for (const row of good) {
    const next = appendSessionBlock(text, renderSessionEntry(row.session));
    if (next === null) {
      ui.error(`${config.path} has no "sessions:" section; add them by hand`);
      return;
    }
    text = next;
  }
  auditedWrite({ config, action: "config.changed", target: good.map((row) => row.session.name).join(","), node: nodeName }, () =>
    writeFileSync(config.path, text),
  );
  note("adopt", good.map((row) => row.session.name).join(","), { node: nodeName, detail: `${good.length} session(s)` });
  ui.info(`adopted ${good.length}: ${good.map((row) => row.session.name).join(", ")} → ${config.path}`);
  ui.info(`take effect on restart: pp restart ${good.map((row) => row.session.name).join(" ")}`);
}

async function cmdRm(config, options, ui) {
  // never sweep: a bare `pp rm` would delete the whole farm by accident
  if (!options.names.length) {
    ui.error("nothing to remove — name the session(s): pp rm <name|#> (pp ls lists them)");
    process.exitCode = 2;
    return;
  }
  const sessions = selectSessions(config, options.names, ui, { all: false, options });
  if (!sessions.length) {
    ui.error("nothing to remove — name the session(s): pp rm <name|#>");
    process.exitCode = 2;
    return;
  }

  const target = sessions.map((session) => {
    let running = false;
    try {
      running = makeTmux(config, options, session).sessionExists(session.tmuxName);
    } catch {
      running = false; // an unreachable node is reported as "no tmux session"
    }
    return { session, running };
  });
  const names = target.map((row) => row.session.tmuxName).join(", ");
  // deleting a session off a machine somebody is patching right now is not a
  // side effect --force should be able to carry on its own
  const drained = target.filter((row) => drainOf(config, row.session)).map((row) => row.session.tmuxName);
  if (drained.length && !options.yes && !options.dryRun) {
    ui.error(
      `refusing to delete ${drained.join(", ")}: drained machine (maintenance) — pass --yes if you really mean it`,
    );
    process.exitCode = 2;
    return;
  }

  if (!options.force && !options.dryRun) {
    if (!process.stdin.isTTY) {
      ui.error(`refusing to delete ${names} without --force (removes the tmux session and its config entry)`);
      process.exitCode = 2;
      return;
    }
    const guarded = target.filter((row) => guardOf(config, row.session)).map((row) => row.session.tmuxName);
    const warning = guarded.length ? ` (guarded machine: ${guarded.join(", ")})` : "";
    const ok = await confirmOnTerminal(
      `delete ${names}? the tmux session and its entry in ${config.path} both go away${warning} [y/N] `,
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
      makeTmux(config, options, session).kill(session.tmuxName);
      killed += 1;
    }
    clearStopped(config.path, session.name);
    const dropEntry = Boolean(config.path) && !options.noConfig;
    const gone = dropEntry
      ? options.dryRun
        ? true
        : auditedWrite({ config, action: "config.changed", target: session.name }, () =>
            removeSessionFromFile(config.path, session.name),
          )
      : false;
    if (gone) removed += 1;
    const bits = [
      running ? "tmux session" : "no tmux session",
      dropEntry ? (gone ? "config entry" : "no config entry") : "config entry kept",
    ];
    ui.info(`${ui.paint("red", label)} ${session.tmuxName}  ${ui.paint("dim", `(${bits.join(", ")})`)}`);
  }

  note(drained.length ? "rm.forced" : "rm", target.map((row) => row.session.name).join(","), {
    detail: `${killed} killed, ${removed} config entr${removed === 1 ? "y" : "ies"} deleted`,
    result: options.force ? "force" : "ok",
    dryRun: options.dryRun,
  });
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
  const sessions = selectSessions(config, options.names, ui, { options, respectDrain: true });
  if (!sessions.length) {
    ui.info("nothing to restart");
    return;
  }
  for (const session of sessions) {
    const tmux = makeTmux(config, options, session);
    if (tmux.sessionExists(session.tmuxName)) tmux.kill(session.tmuxName);
  }
  note("restart", sessions.map((session) => session.name).join(","), { detail: `${sessions.length} restarted`, result: "ok" });
  options.force = true;
  // the restart itself is the interesting entry; the up it performs is noise
  await cmdUp(config, { ...options, names: sessions.map((s) => s.name), skipAudit: true, startedWhy: "restart" }, ui);
}

/* ------------------------------------------------------------------ nodes */

function findNode(config, ref) {
  const name = String(ref ?? "").trim();
  if (!name) return null;
  return (config?.nodes ?? []).find((n) => n.name === name) ?? null;
}

function nodeOrDie(config, ref, ui) {
  const name = String(ref ?? "").trim();
  if (!name) {
    ui.error("which node? usage: pp node <ls|show|add|rm|test|ssh> [name]");
    process.exit(2);
  }
  const node = findNode(config, name);
  if (!node) {
    const known = (config?.nodes ?? []).map((n) => n.name);
    ui.error(`no node "${name}"${known.length ? ` (known: ${known.join(", ")})` : " — add one: pp node add " + name + " --host <ip>"}`);
    process.exit(2);
  }
  return node;
}

function printNodes(config, options, ui) {
  const filtered = Boolean(options.node) || Boolean(options.tags?.length);
  const nodes = filtered ? taggedNodes(config, options) : (config?.nodes ?? []);
  const counts = new Map();
  for (const session of config?.sessions ?? []) {
    if (session.node) counts.set(session.node, (counts.get(session.node) ?? 0) + 1);
  }
  if (ui.json) {
    ui.out(
      JSON.stringify(
        nodes.map((node) => ({
          name: node.name,
          host: node.host,
          port: node.port,
          user: node.user,
          target: nodeTarget(node),
          auth: authSummary(node),
          identity: node.identity,
          password_env: node.passwordEnv,
          has_password: Boolean(node.password),
          sessions: counts.get(node.name) ?? 0,
          tags: node.tags ?? [],
          guarded: Boolean(node.guarded),
          drained: Boolean(node.drained),
          note: node.note,
        })),
        null,
        2,
      ),
    );
    return;
  }
  if (!nodes.length && filtered) {
    ui.info(`no node matches ${[options.node ? `--node ${options.node}` : "", options.tags?.length ? `--tag ${options.tags.join(" --tag ")}` : ""].filter(Boolean).join(" ")}`);
    return;
  }
  if (!nodes.length) {
    ui.info("no nodes yet. A session can run on another machine once you register it:");
    ui.info("  pp node add prod-01 --host 10.0.0.11 --user deploy --identity ~/.ssh/id_ed25519");
    ui.info("  pp node test prod-01");
    return;
  }
  const headers = ["NODE", "TARGET", "PORT", "AUTH", "SESSIONS", "TAGS", "NOTE"];
  const table = nodes.map((node) => [
    `${node.guarded ? "!" : ""}${node.drained ? "~" : ""}${node.name}`,
    nodeTarget(node),
    String(node.port),
    authSummary(node),
    String(counts.get(node.name) ?? 0),
    (node.tags ?? []).join(","),
    node.note || "",
  ]);
  const widths = headers.map((h, i) => Math.max(h.length, ...table.map((row) => row[i].length)));
  const pad = (value, width) => value + " ".repeat(Math.max(0, width - value.length));
  ui.out(ui.paint("bold", headers.map((h, i) => pad(h, widths[i])).join("  ").trimEnd()));
  table.forEach((row, i) => {
    const cells = [...row];
    cells[0] = ui.paint("cyan", cells[0]);
    const auth = nodes[i] && authSummary(nodes[i]);
    if (auth.endsWith("✗")) cells[3] = ui.paint("red", cells[3]);
    else if (auth === "agent") cells[3] = ui.paint("dim", cells[3]);
    cells[4] = ui.paint("dim", cells[4]);
    ui.out(cells.map((cell, idx) => pad(cell, widths[idx])).join("  ").trimEnd());
  });
  if (!options.quiet) {
    if (nodes.some((node) => node.guarded)) {
      ui.out(ui.paint("dim", "\n! = guarded: pp down / pp rm skip its sessions unless you pass --force"));
    }
    if (nodes.some((node) => node.drained)) {
      ui.out(ui.paint("dim", "~ = drained: pp up / pp restart skip its sessions (maintenance) — pp node undrain <name>"));
    }
    ui.out(`\n${nodes.length} node${nodes.length === 1 ? "" : "s"}  ${ui.paint("dim", `config: ${config.path}`)}`);
    const orphan = nodes.length && !counts.size ? "  (no session uses one yet: add `node: <name>` to a session)" : "";
    if (orphan) ui.out(ui.paint("dim", orphan.trim()));
  }
}

function showNode(config, options, ui) {
  const node = nodeOrDie(config, options.names[1], ui);
  const used = sessionsOnNode(config, node.name);
  if (ui.json) {
    ui.out(
      JSON.stringify(
        {
          ...node,
          password: node.password ? "********" : null,
          target: nodeTarget(node),
          auth: authSummary(node),
          sessions: used.map((s) => s.name),
        },
        null,
        2,
      ),
    );
    return;
  }
  const rows = [
    ["name", node.name],
    ["target", `${nodeTarget(node)}:${node.port}`],
    ["host", node.host],
    ["port", String(node.port)],
    ["user", node.user ?? ui.paint("dim", "(ssh default)")],
    ["auth", authSummary(node)],
    ["identity", node.identity ?? ui.paint("dim", "-")],
    ["password", node.password ? ui.paint("yellow", "set (in the config file)") : node.passwordEnv ? ui.paint("dim", `from $${node.passwordEnv}`) : ui.paint("dim", "-")],
    ["tags", node.tags?.length ? node.tags.join(", ") : ui.paint("dim", "-")],
    ["guarded", node.guarded ? ui.paint("yellow", "yes — pp down / pp rm need --force") : ui.paint("dim", "no")],
    ["drained", node.drained ? ui.paint("yellow", "yes — pp up / pp restart skip its sessions (maintenance)") : ui.paint("dim", "no")],
    ["base_path", node.basePath || ui.paint("dim", "-")],
    [
      "defaults",
      node.defaults && Object.keys(node.defaults).length
        ? Object.entries(node.defaults)
            .map(([key, value]) => `${key}=${Array.isArray(value) ? value.join(" ") : value}`)
            .join("  ")
        : ui.paint("dim", "-"),
    ],
    ["note", node.note || ui.paint("dim", "-")],
    ["sessions", used.length ? used.map((s) => `${s.name}${s.node === node.name ? "" : ""}`).join(", ") : ui.paint("dim", "none")],
  ];
  const width = Math.max(...rows.map(([k]) => k.length));
  for (const [key, value] of rows) ui.out(`${ui.paint("dim", key.padEnd(width))}  ${value}`);
  if (!options.quiet) ui.out(`\n${ui.paint("dim", `config: ${config.path}`)}`);
}

async function promptOnTerminal(question, fallback = "") {
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const suffix = fallback ? ui0Dim(` [${fallback}]`) : "";
    const answer = (await rl.question(`${question}${suffix}: `)).trim();
    return answer || fallback;
  } finally {
    rl.close();
  }
}

function ui0Dim(text) {
  return process.stdout.isTTY && !process.env.NO_COLOR ? `\u001b[2m${text}\u001b[0m` : text;
}

async function cmdNodeAdd(config, options, ui) {
  if (!config?.path) {
    ui.error("no config file to write to — run `pp init` first");
    process.exit(2);
  }
  const name = options.names[1];
  if (!name) {
    ui.error(
      "usage: pp node add <name> --host <ip|dns> [--port 22] [--user deploy]\n" +
        "                        [--identity ~/.ssh/id_ed25519 | --password | --password-env VAR]\n" +
        "                        [--note \"what this box is\"] [--from-ssh-config <alias>]",
    );
    process.exit(2);
  }

  let spec = { name };
  if (options.fromSshConfig) {
    const path = join(homedir(), ".ssh", "config");
    if (!existsSync(path)) {
      ui.error(`no ${path} to read`);
      process.exit(2);
    }
    const entries = parseSshConfig(readFileSync(path, "utf8"));
    const entry = entries.find((e) => e.name === options.fromSshConfig);
    if (!entry) {
      ui.error(
        `no Host "${options.fromSshConfig}" in ${path}${entries.length ? ` (known: ${entries.map((e) => e.name).join(", ")})` : ""}`,
      );
      process.exit(2);
    }
    spec = { name, host: entry.host, port: entry.port, user: entry.user ?? undefined, identity: entry.identity ?? undefined };
  }
  if (options.host) spec.host = options.host;
  if (options.port) spec.port = options.port;
  if (options.user) spec.user = options.user;
  if (options.identity) spec.identity = options.identity;
  if (options.password) spec.password = options.password;
  if (options.passwordEnv) spec.password_env = options.passwordEnv;
  if (options.note) spec.note = options.note;
  if (options.guard) spec.guarded = true;
  if (options.noGuard) spec.guarded = false;
  if (options.basePath !== undefined) spec.base_path = options.basePath;
  if (options.defaultAgent || options.defaultRestart || options.defaultRemotePiMode) {
    spec.defaults = {};
    if (options.defaultAgent) spec.defaults.agent = options.defaultAgent;
    if (options.defaultRestart) spec.defaults.restart = options.defaultRestart;
    if (options.defaultRemotePiMode) spec.defaults.remote_pi_mode = options.defaultRemotePiMode;
  }
  // Re-adding a node is the documented way to edit it, so everything the
  // command line did not mention has to survive the rewrite.
  const previous = (config.nodes ?? []).find((n) => n.name === name);
  if (previous) {
    const tags = options.tags?.length ? [...new Set([...(previous.tags ?? []), ...options.tags])] : previous.tags;
    if (tags?.length) spec.tags = tags;
    if (spec.note === undefined && previous.note) spec.note = previous.note;
    if (spec.guarded === undefined && previous.guarded) spec.guarded = true;
    if (spec.identity === undefined && previous.identity) spec.identity = previous.identity;
    if (spec.password === undefined && previous.password) spec.password = previous.password;
    if (spec.password_env === undefined && previous.passwordEnv) spec.password_env = previous.passwordEnv;
    if (spec.base_path === undefined && previous.basePath) spec.base_path = previous.basePath;
    if (spec.user === undefined && previous.user) spec.user = previous.user;
    if (spec.port === undefined && previous.port) spec.port = previous.port;
    // editing a machine should not require repeating where it is
    if (!spec.host && previous.host) spec.host = previous.host;
    const defaults = { ...(spec.defaults ?? {}) };
    for (const [key, value] of Object.entries(previous.defaults ?? {})) {
      if (defaults[key] === undefined) defaults[key] = value;
    }
    if (Object.keys(defaults).length) spec.defaults = defaults;
  } else if (options.tags?.length) {
    spec.tags = options.tags;
  }

  if (!spec.host && process.stdin.isTTY && !ui.json) {
    ui.info(ui.paint("dim", `registering the machine "${name}" — answer four questions (Enter accepts the default)`));
    spec.host = await promptOnTerminal("ip or dns name");
    spec.port = await promptOnTerminal("ssh port", "22");
    spec.user = await promptOnTerminal("ssh user", process.env.USER ?? "");
    const auth = await promptOnTerminal("auth: key path, \"password\" or $VAR", "~/.ssh/id_ed25519");
    if (auth === "password") spec.password = await promptOnTerminal("password (stored in the config, file will be 0600)");
    else if (/^\$[A-Za-z_][A-Za-z0-9_]*$/.test(auth)) spec.password_env = auth.slice(1);
    else if (auth) spec.identity = auth;
  }
  if (!spec.host) {
    ui.error(`missing --host for node "${name}" (ip or dns name of the machine)`);
    process.exit(2);
  }

  const warnings = [];
  let node;
  try {
    node = normalizeNode(spec, (config.nodes ?? []).length, config.path, warnings);
  } catch (err) {
    ui.error(err.message);
    process.exit(2);
  }
  const existing = (config.nodes ?? []).find((n) => n.name === node.name);
  if (existing && !options.force) {
    // Re-adding is the documented way to edit a node, but say what changed.
    const changed = ["host", "port", "user", "identity", "password", "note", "tags", "basePath", "guarded"].filter(
      (key) => String(existing[key] ?? "") !== String(node[key] ?? ""),
    );
    if (JSON.stringify(existing.defaults ?? {}) !== JSON.stringify(node.defaults ?? {})) changed.push("defaults");
    if (!changed.length) {
      ui.info(`${node.name} is unchanged (${nodeTarget(node)}:${node.port}, ${authSummary(node)})`);
      return;
    }
    ui.info(`updating ${node.name}: ${changed.join(", ")}`);
  }
  for (const warning of warnings) ui.warn(warning);

  if (options.dryRun) {
    ui.info(`[dry-run] would write node ${node.name} to ${config.path}`);
    for (const line of renderNodeBlock(node).split("\n")) ui.info(ui.paint("dim", line));
    return;
  }
  const action = auditedWrite({ config, action: "config.changed", target: node.name, node: node.name, dryRun: options.dryRun }, () =>
    upsertNodeInFile(config.path, node),
  );
  if (node.password) {
    tightenConfigMode(config.path);
    ui.warn(
      `the password is stored in ${config.path} (mode 600). ` +
        `On a shared box prefer --password-env <VAR> or --identity <key>`,
    );
  }
  note(`node.${action === "updated" ? "update" : "add"}`, node.name, { detail: `${nodeTarget(node)}:${node.port} (${authSummary(node)})`, result: "ok" });
  {
    ui.info(`${action === "updated" ? "updated" : "added"} node ${ui.paint("cyan", node.name)} → ${nodeTarget(node)}:${node.port} (${authSummary(node)})`);
  }
  if (!options.quiet) ui.info(`Next: pp node test ${node.name}`);
}

function cmdNodeRm(config, options, ui) {
  const node = nodeOrDie(config, options.names[1], ui);
  const used = sessionsOnNode(config, node.name);
  if (used.length && !options.force) {
    ui.error(
      `${used.length} session${used.length === 1 ? "" : "s"} still run on "${node.name}": ` +
        used.map((s) => s.name).join(", ") +
        `\nrepoint them (node: <other>) or pass --force to leave them dangling`,
    );
    process.exit(1);
  }
  const removed = auditedWrite({ config, action: "config.changed", target: node.name, node: node.name }, () =>
    removeNodeFromFile(config.path, node.name),
  );
  if (!removed) {
    ui.error(`could not find "${node.name}" in ${config.path}`);
    process.exit(1);
  }
  note("node.rm", node.name, { detail: `${used.length} session(s) now point at a missing node`, result: options.force ? "force" : "ok" });
  ui.info(`removed node ${node.name}${used.length ? ui.paint("dim", ` (${used.length} session(s) now point at a missing node)`) : ""}`);
}

function cmdNodeTest(config, options, ui) {
  const refs = options.all || options.tags?.length
    ? taggedNodes(config, options).map((node) => node.name)
    : options.names.slice(1);
  if (!refs.length) {
    ui.error("usage: pp node test <name>... | --all");
    process.exit(2);
  }
  let failed = 0;
  for (const ref of refs) {
    const node = findNode(config, ref);
    if (!node) {
      failed++;
      ui.error(`no node "${ref}"`);
      continue;
    }
    const started = Date.now();
    let probe;
    try {
      const res = runOnNode(node, [PROBE_SCRIPT]);
      if (res.timedOut) throw new NodeError("ssh timed out");
      if (res.status !== 0) {
        const detail = (res.stderr || res.stdout).trim().split("\n").filter(Boolean).slice(-1)[0] || `ssh exited ${res.status}`;
        throw new NodeError(detail);
      }
      probe = parseProbe(res.stdout);
    } catch (err) {
      failed++;
      ui.error(`${node.name} (${nodeTarget(node)}): ${err.message}`);
      continue;
    }
    const ms = Date.now() - started;
    const dot = (value) => (value && value !== "-" ? value : ui.paint("red", "missing"));
    if (ui.json) {
      ui.out(JSON.stringify({ node: node.name, ok: true, ms, ...probe }, null, 2));
      continue;
    }
    ui.out(
      `${ui.paint("green", "ok")}   ${ui.paint("cyan", node.name.padEnd(12))} ${nodeTarget(node)}:${node.port}  ${ui.paint("dim", `${ms}ms`)}`,
    );
    ui.out(`     ${ui.paint("dim", "host")}   ${probe.host ?? "?"}  ${ui.paint("dim", "os")} ${probe.os ?? "?"}`);
    ui.out(
      `     ${ui.paint("dim", "tmux")}   ${dot(probe.tmux)}   ${ui.paint("dim", "node")} ${dot(probe.node)}   ` +
        `${ui.paint("dim", "pi")} ${dot(probe.pi)}   ${ui.paint("dim", "pp")} ${probe.pp && probe.pp !== "-" ? probe.pp : ui.paint("dim", "not installed")}`,
    );
    ui.out(
      `     ${ui.paint("dim", "sessions")} ${probe.sessions ?? "?"}   ${ui.paint("dim", "load")} ${probe.load ?? "?"}   ${ui.paint("dim", "up")} ${probe.up && probe.up !== "-" ? `${Math.floor(Number(probe.up) / 3600)}h` : "?"}`,
    );
    if (!probe.tmux || probe.tmux === "-") {
      ui.warn(`${node.name} has no tmux — sessions cannot run there until it is installed (apt install tmux)`);
    }
    if (!probe.pi || probe.pi === "-") {
      ui.warn(`${node.name} has no pi on PATH for that user — agent sessions there will fail to start`);
    }
  }
  if (failed) process.exitCode = 1;
}

function cmdNodeSsh(config, options, ui) {
  const node = nodeOrDie(config, options.names[1], ui);
  const inv = sshInvocation(node, [], { tty: true, batch: false });
  if (options.dryRun) {
    ui.info(`[dry-run] ${inv.command} ${inv.argv.join(" ")}`);
    return;
  }
  const res = spawnSync(inv.command, inv.argv, { stdio: "inherit", env: { ...process.env, ...inv.env } });
  if (res.error && res.error.code === "ENOENT") {
    ui.error(
      inv.command === "sshpass"
        ? `node "${node.name}" uses a password: install sshpass (apt install sshpass) or switch to --identity`
        : "ssh is not installed (or not on PATH)",
    );
    process.exit(1);
  }
  process.exit(res.status ?? 0);
}

/**
 * Run one command on one machine, or on all of them.
 *
 * The tokens after `--` are joined into a single remote command string: ssh
 * hands the remote shell one command line, so anything else would lose the
 * quoting the user typed (`pp node exec db -- docker ps --format {{.Names}}`).
 */
async function cmdNodeExec(config, options, ui) {
  const command = options.rest ?? [];
  // names holds the tokens before `--` *and* the payload after it.
  const refs = options.all || options.tags?.length
    ? taggedNodes(config, options).map((node) => node.name)
    : options.names.slice(1, options.names.length - (options.rest?.length ?? 0));
  if (!refs.length) {
    if (options.tags?.length || options.node) {
      ui.error(`no node matches ${[options.node ? `--node ${options.node}` : "", ...(options.tags ?? []).map((t) => `--tag ${t}`)].filter(Boolean).join(" ")}`);
      process.exit(1);
    }
    ui.error("usage: pp node exec <name>... | --all -- <command>");
    process.exit(2);
  }
  if (!command.length) {
    ui.error("nothing to run — put the command after a --, e.g. pp node exec db-01 -- uptime");
    process.exit(2);
  }
  const remote = command.join(" ");
  const timeout = Math.max(1, Number(options.timeout ?? 60)) * 1000;

  // One machine at a time by default (readable output, no thundering herd);
  // --parallel fires them all at once for a big fleet.
  const runOne = async (ref) => {
    const node = findNode(config, ref);
    if (!node) return { node: ref, ok: false, status: null, ms: 0, stdout: "", stderr: `no node "${ref}"` };
    const started = Date.now();
    try {
      const res = options.parallel
        ? await runOnNodeAsync(node, [remote], { timeout })
        : runOnNode(node, [remote], { timeout });
      return {
        node: node.name,
        target: nodeTarget(node),
        ok: res.status === 0 && !res.timedOut,
        status: res.status,
        ms: Date.now() - started,
        stdout: res.stdout,
        stderr: res.timedOut ? `${res.stderr}${res.stderr ? "\n" : ""}timed out after ${timeout / 1000}s` : res.stderr,
      };
    } catch (err) {
      return {
        node: node.name,
        target: nodeTarget(node),
        ok: false,
        status: null,
        ms: Date.now() - started,
        stdout: "",
        stderr: err.message,
      };
    }
  };

  const results = options.parallel
    ? await Promise.all(refs.map((ref) => runOne(ref)))
    : await refs.reduce(async (previous, ref) => [...(await previous), await runOne(ref)], Promise.resolve([]));

  for (const result of results) {
    if (ui.json) continue;
    if (options.quiet && result.ok) continue;
    const head = result.ok
      ? `${ui.paint("green", "ok")}   ${ui.paint("cyan", result.node.padEnd(12))} ${ui.paint("dim", `exit 0  ${result.ms}ms`)}`
      : `${ui.paint("red", "fail")} ${ui.paint("cyan", result.node.padEnd(12))} ${ui.paint("dim", `exit ${result.status ?? "?"}  ${result.ms}ms`)}`;
    ui.out(refs.length > 1 ? `===== ${head}` : head);
    const body = (result.stdout ?? "").replace(/\n$/, "");
    if (body) ui.out(body);
    if (result.stderr.trim()) ui.out(ui.paint("dim", result.stderr.trimEnd()));
  }
  if (ui.json) ui.out(JSON.stringify(results.length === 1 ? results[0] : results, null, 2));
  if (results.some((result) => !result.ok)) process.exitCode = 1;
}

/**
 * Draining a machine is the mirror image of `guarded`: guarded stops an
 * accidental `down`, drained stops an accidental `up`. Maintenance windows are
 * exactly when the autostart unit and `pp cron --heal` try hardest to help.
 */
function cmdNodeDrain(config, options, ui, { drained = true } = {}) {
  if (!config) throw new CliError("no config file yet — run `pp init`");
  const name = options.names[1];
  if (!name) throw new CliError(`which machine? pp node ${drained ? "drain" : "undrain"} <name>`);
  const node = nodeOrDie(config, name, ui);
  if ((node.drained ?? false) === drained) {
    ui.info(`${name} is ${drained ? "already drained" : "not drained"} — nothing to change`);
    return;
  }
  const behind = sessionsOnNode(config, name);
  if (options.dryRun) {
    ui.out(`[dry-run] would set ${drained ? "drained: true" : "drained: false"} on node "${name}"`);
  } else {
    auditedWrite({ config, action: "config.changed", target: name, node: name }, () =>
      setNodeFieldInFile(config.path, name, "drained", drained ? "true" : null),
    );
    note(drained ? "node.drain" : "node.undrain", name, {
      detail: `${behind.length} session${behind.length === 1 ? "" : "s"} on it`,
    });
  }
  if (drained) {
    ui.info(`drained ${name} — pp up, the autostart unit and --heal leave its sessions down`);
    if (behind.length) {
      ui.out(ui.paint("dim", `  ${behind.map((s) => s.tmuxName).join(", ")} stay as they are; stop them now with: pp down --node ${name}`));
    }
    ui.out(ui.paint("dim", `  back to normal: pp node undrain ${name}`));
  } else {
    ui.info(`undrained ${name} — its sessions start again on the next pp up / tick`);
    if (behind.length) ui.out(ui.paint("dim", `  start them now: pp up --node ${name}`));
  }
}

async function cmdNode(config, options, ui) {
  const sub = (options.names[0] ?? "ls").toLowerCase();
  if (["ls", "list", "status"].includes(sub)) {
    if (!config) {
      ui.info("no config file yet — run `pp init` to create one, then `pp node add`");
      return;
    }
    return printNodes(config, options, ui);
  }
  if (["show", "info", "describe"].includes(sub)) return showNode(config, options, ui);
  if (["add", "set", "upsert"].includes(sub)) return cmdNodeAdd(config, options, ui);
  if (["rm", "remove", "delete"].includes(sub)) return cmdNodeRm(config, options, ui);
  if (["test", "ping", "probe", "check"].includes(sub)) return cmdNodeTest(config, options, ui);
  if (["ssh", "shell", "connect"].includes(sub)) return cmdNodeSsh(config, options, ui);
  if (["exec", "run", "sh"].includes(sub)) return cmdNodeExec(config, options, ui);
  if (["drain", "maintenance"].includes(sub)) return cmdNodeDrain(config, options, ui, { drained: true });
  if (["undrain", "resume", "unmaintenance"].includes(sub)) return cmdNodeDrain(config, options, ui, { drained: false });
  ui.error(`unknown node command "${sub}" — try: pp node ls | show | add | rm | test | exec | ssh | drain`);
  process.exit(2);
}

/**
 * Why a session is down, in the words an operator would use. The table footer
 * only had a count ("2 down"), which answers "is anything wrong" but not "what
 * do I type next" -- `pp check` was the only way to find out.
 */
export function downReasons(rows) {
  const groups = new Map();
  for (const row of rows) {
    if (!["off", "stopped", "dead", "unreachable"].includes(row.state)) continue;
    const why =
      row.reason === "drain"
        ? "on a drained machine"
        : row.reason === "hand"
          ? "stopped by hand"
          : row.state === "unreachable"
            ? "machine unreachable"
            : row.state === "dead"
              ? "agent exited"
              : row.cwdMissing
                ? "cwd is gone"
                : "not started";
    groups.set(why, (groups.get(why) ?? 0) + 1);
  }
  // most actionable first: a broken cwd or an unreachable box is something to
  // fix now, "not started" usually just means nobody got to it
  const order = ["cwd is gone", "machine unreachable", "agent exited", "on a drained machine", "stopped by hand", "not started"];
  const rank = (why) => (order.includes(why) ? order.indexOf(why) : order.length);
  return [...groups.entries()]
    .sort((a, b) => rank(a[0]) - rank(b[0]) || b[1] - a[1])
    .map(([why, count]) => ({ why, count }));
}

export function formatDownReasons(reasons, most = 3) {
  const shown = reasons.slice(0, most).map((entry) => `${entry.count} ${entry.why}`);
  const rest = reasons.length - shown.length;
  const total = reasons.reduce((sum, entry) => sum + entry.count, 0);
  return `${total} down (${shown.join(", ")}${rest > 0 ? `, ${rest} more` : ""})`;
}

function cmdStatus(config, options, ui) {
  if (options.watch !== undefined && !options.json) return cmdStatusWatch(config, options, ui);
  // status lists every configured session, whatever its restart policy.
  const sessions = selectSessions(config, options.names, ui, { all: true, options });
  if (!sessions.length && options.node) {
    ui.info(`no sessions on node "${options.node}"`);
    return;
  }
  // One tmux query per machine, not one per session: a node is expensive to
  // reach and every session on it shares the answer.
  const liveCache = new Map();
  const unreachable = new Set();
  const liveFor = (nodeName) => {
    const key = nodeName ?? "";
    if (liveCache.has(key)) return liveCache.get(key);
    let map = new Map();
    try {
      const handle = makeTmux(config, options, { node: nodeName });
      // A machine we cannot reach is not "all sessions stopped" — say so.
      if (nodeName && !handle.reachable()) unreachable.add(nodeName);
      else map = handle.listSessions();
    } catch {
      if (nodeName) unreachable.add(nodeName);
    }
    liveCache.set(key, map);
    return map;
  };

  // who is attached, per machine: fetched once, like the session list
  const clientCache = new Map();
  const clientsFor = (nodeName) => {
    const key = nodeName ?? "";
    if (clientCache.has(key)) return clientCache.get(key);
    let list = [];
    try {
      list = makeTmux(config, options, { node: nodeName }).listClients();
    } catch {
      list = [];
    }
    clientCache.set(key, list);
    return list;
  };

  // scheduled jobs aimed at each session: the answer to "why does this pane
  // keep talking on its own?" without reading cron.json by hand
  const cronFor = (() => {
    let jobs = [];
    try {
      jobs = readJobs();
    } catch {
      jobs = [];
    }
    const counts = new Map();
    let broadcast = 0;
    for (const job of jobs) {
      if (job.action === "heal") continue;
      if (job.session === ALL_SESSIONS) {
        broadcast++;
        continue;
      }
      if (!job.session) continue;
      counts.set(job.session, (counts.get(job.session) ?? 0) + 1);
    }
    return (tmuxName) => {
      const own = counts.get(tmuxName) ?? 0;
      if (own && broadcast) return `${own}*`;
      if (own) return String(own);
      if (broadcast) return "*";
      return "";
    };
  })();

  const SORT_KEYS = new Set(["config", "idle", "name"]);
  const sortKey = options.sort ?? "config";
  if (!SORT_KEYS.has(sortKey)) {
    ui.error(`unknown --sort "${sortKey}" (try config, idle, name)`);
    process.exit(2);
  }
  const idleOver = options.idleOver ? parseDuration(options.idleOver, { what: "--idle-over" }) : null;

  // how many things are still waiting inside each session: a session that is
  // "running" and has two unanswered questions is not the same as an idle one
  const todoFor = (() => {
    const counts = new Map();
    try {
      for (const todo of readTodos()) {
        if (todo.state === "done" || !todo.session) continue;
        counts.set(todo.session, (counts.get(todo.session) ?? 0) + 1);
      }
    } catch {
      return () => 0;
    }
    return (tmuxName) => counts.get(tmuxName) ?? 0;
  })();

  const rows = sessions.map((session) => {
    const entry = liveFor(session.node).get(session.tmuxName);
    const pane = entry?.panes[0];
    let state = session.node && unreachable.has(session.node) ? "unreachable" : "stopped";
    let pid = "";
    let command = "";
    if (entry && pane) {
      if (pane.dead) state = "dead";
      else if (entry.attached > 0) state = "attached";
      else state = "running";
      pid = String(pane.pid ?? "");
      command = pane.command ?? "";
    }
    const activity = entry?.activity ?? 0;
    const idleSeconds = activity ? Math.max(0, Math.round(Date.now() / 1000 - activity)) : null;
    return {
      index: config.sessions.indexOf(session) + 1,
      name: session.name,
      node: session.node ?? "",
      tmux: session.tmuxName,
      todos: todoFor(session.tmuxName),
      state: state === "stopped" && (session.restart === "no" || isStopped(config.path, session.name)) ? "off" : state,
      // why it is not running matters at 3am: "someone stopped it on purpose"
      // and "it never came up" need different answers from the operator
      reason: state === "stopped"
        ? drainOf(config, session)
          ? "drain"
          : isStopped(config.path, session.name)
            ? "hand"
            : session.restart === "no"
              ? "policy"
              : "never"
        : "",
      restart: session.restart,
      pid,
      command,
      cwd: session.cwd,
      pi: session.pi,
      piSession: session.piSession ?? "",
      piSessionName: session.piSessionName ?? "",
      activity,
      idleSeconds,
      idle: idleSeconds === null ? "" : shortAge(idleSeconds),
      remotePiName: session.remotePiName ?? "",
      // scheduled jobs aimed at this session (heal jobs are fleet-wide, not per session)
      cron: cronFor(session.tmuxName),
      // things still waiting inside: unanswered questions, unread turns
      todos: todoFor(session.tmuxName),
      // a local cwd that vanished is the most common reason a session will not
      // come up, and the only one we can see without asking the machine
      cwdMissing: session.node ? false : !existsSync(expandPath(session.cwd)),
      // who put it back up, and why — "did it come back by itself?" in one column
      lastStart: startedOf(config.path, session.name),
      restarts: restartsOf(config.path, session.name),
      // "who is looking at this" — the question before `pp down` on a shared box
      client: (() => {
        const client = clientsFor(session.node).find((entry) => entry.session === session.tmuxName);
        return client ? `${client.user || "?"}@${client.tty || client.name}` : "";
      })(),
    };
  });

  let shown = rows;
  if (idleOver !== null) {
    shown = rows.filter((row) => row.idleSeconds !== null && row.idleSeconds >= idleOver);
    if (!shown.length) {
      ui.info(`no session has been quiet for ${shortAge(idleOver)} or more`);
      return;
    }
  }
  if (sortKey === "idle") {
    // quietest first: the ones worth a look come before the busy ones
    shown = [...shown].sort((a, b) => (b.idleSeconds ?? -1) - (a.idleSeconds ?? -1));
  } else if (sortKey === "name") {
    shown = [...shown].sort((a, b) => a.name.localeCompare(b.name));
  }

  if (ui.json) {
    // the same two counts the footer shows, so a script does not have to
    // re-derive "is this machine still what the config says" from row states
    const jsonDown = rows.filter((r) => r.state === "off" || r.state === "stopped" || r.state === "dead").length;
    const jsonConfigured = new Set(config.sessions.map((session) => `${session.node ?? ""}:${session.tmuxName}`));
    const jsonStrays = [];
    for (const [key, map] of liveCache ?? []) {
      const nodeName = key === "local" ? "" : key;
      for (const name of map.keys()) if (!jsonConfigured.has(`${nodeName}:${name}`)) jsonStrays.push(name);
    }
    ui.out(
      JSON.stringify(
        {
          sessions: shown,
          drift: { down: jsonDown, unmanaged: jsonStrays.length, stray: jsonStrays, reasons: downReasons(rows) },
        },
        null,
        2,
      ),
    );
    return;
  }

  const showNode = (config.nodes?.length ?? 0) > 0;
  // the CLIENT column only earns its width when somebody is actually attached
  const showClient = rows.some((row) => row.client);
  // so does CRON: a fleet with no schedules should not pay for the column
  const showCron = rows.some((row) => row.cron);
  // and TODOS: only when something is actually waiting somewhere
  const showTodos = rows.some((row) => row.todos);
  // STARTED is opt-in: it answers "did it restart by itself?" not "is it up?"
  const showStarted = Boolean(options.started) && rows.some((row) => row.lastStart);
  const headers = [
    ...(showNode
      ? ["#", "NAME", "NODE", "STATE", "IDLE", "RESTART", "PID", "AGENT", "CWD", "PI SESSION", "REMOTE-PI"]
      : ["#", "NAME", "STATE", "IDLE", "RESTART", "PID", "AGENT", "CWD", "PI SESSION", "REMOTE-PI"]),
    ...(showCron ? ["CRON"] : []),
    ...(showTodos ? ["TODOS"] : []),
    ...(showClient ? ["CLIENT"] : []),
    ...(showStarted ? ["STARTED"] : []),
  ];
  const table = shown.map((r) => [
    String(r.index),
    r.name,
    ...(showNode ? [r.node || "-"] : []),
    r.state === "off" && r.reason === "hand"
      ? "off (hand)"
      : r.state === "off" && r.reason === "drain"
        ? "off (drain)"
        : r.state,
    r.idle || "-",
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
    ...(showCron ? [r.cron || "-"] : []),
    ...(showTodos ? [r.todos ? String(r.todos) : "-"] : []),
    ...(showClient ? [r.client || "-"] : []),
    ...(showStarted ? [r.lastStart ? `${shortAge(Math.max(0, Math.round((Date.now() - Date.parse(r.lastStart.at)) / 1000)))} ${r.lastStart.why}` : "-"] : []),
  ]);
  const widths = headers.map((h, i) => Math.max(h.length, ...table.map((row) => row[i].length)));
  const pad = (value, width) => value + " ".repeat(Math.max(0, width - value.length));
  const at = (name) => headers.indexOf(name);
  ui.out(ui.paint("bold", headers.map((h, i) => pad(h, widths[i])).join("  ").trimEnd()));
  shown.forEach((row, i) => {
    const colored = [...table[i]];
    const stateAt = at("STATE");
    colored[0] = ui.paint("dim", colored[0]);
    if (showNode) colored[2] = ui.paint(row.node ? "cyan" : "dim", colored[2]);
    if (row.state === "off") colored[stateAt] = ui.paint("dim", colored[stateAt]);
    if (row.state === "unreachable") colored[stateAt] = ui.paint("red", "unreachable");
    const color = row.state === "running" ? "green" : row.state === "attached" ? "cyan" : row.state === "dead" || row.state === "unreachable" ? "red" : "dim";
    colored[stateAt] = ui.paint(color, colored[stateAt]);
    const idleAt = at("IDLE");
    if (showCron && row.cron) colored[at("CRON")] = ui.paint("cyan", colored[at("CRON")]);
    if (showTodos && row.todos) colored[at("TODOS")] = ui.paint("yellow", colored[at("TODOS")]);
    if (showStarted && row.lastStart) {
      // anything restarted within the last five minutes is worth a colour: it is
      // usually the thing that just broke
      const recent = Date.now() - Date.parse(row.lastStart.at) < 5 * 60 * 1000;
      colored[at("STARTED")] = ui.paint(recent ? "yellow" : "dim", colored[at("STARTED")]);
    }
    if (showClient && row.client) {
      colored[at("CLIENT")] = ui.paint(row.client.startsWith(`${process.env.USER ?? "?"}@`) ? "dim" : "cyan", colored[at("CLIENT")]);
    }
    if (row.idleSeconds !== null && row.idleSeconds >= staleSeconds()) {
      colored[idleAt] = ui.paint("yellow", colored[idleAt]);
    } else if (row.idle) {
      colored[idleAt] = ui.paint("dim", colored[idleAt]);
    }
    ui.out(colored.map((cell, idx) => pad(cell, widths[idx])).join("  ").trimEnd());
  });
  if (shown.length === 1 && shown[0].lastStart) {
    // one session was asked about: say who brought it back, and when
    const start = shown[0].lastStart;
    const ago = shortAge(Math.max(0, Math.round((Date.now() - Date.parse(start.at)) / 1000)));
    ui.out(
      ui.paint("dim", `last start ${ago} ago by ${start.why}${start.by ? ` (${start.by})` : ""} — pp audit --action up`),
    );
    // "it keeps coming back" is a different problem from "it is not up"
    const history = shown[0].restarts ?? [];
    if (history.length > 1) {
      const first = Date.parse(history[0].at);
      const span = Math.max(0, Math.round((Date.now() - first) / 60000));
      const tally = new Map();
      for (const entry of history) tally.set(entry.why, (tally.get(entry.why) ?? 0) + 1);
      const why = [...tally.entries()].map(([kind, count]) => (count > 1 ? `${kind} ×${count}` : kind)).join(", ");
      ui.out(
        ui.paint(
          history.length >= 3 ? "yellow" : "dim",
          `restarted ${history.length}× in ${span < 1 ? "the last minute" : `${span}m`} — ${why}`,
        ) +
          ui.paint("dim", " — pp logs " + shown[0].name),
      );
    }
  }
  if (!options.quiet) {
    const running = shown.filter((r) => r.state === "running" || r.state === "attached").length;
    const unreachableNodes = [...unreachable];
    // The two numbers an operator looks for: what should be up and is not, and
    // what is up and nobody wrote down.
    const down = rows.filter((r) => r.state === "off" || r.state === "stopped" || r.state === "dead").length;
    const configured = new Set(config.sessions.map((session) => `${session.node ?? ""}:${session.tmuxName}`));
    const unmanaged = [];
    for (const [key, map] of liveCache) {
      const nodeName = key === "local" ? "" : key;
      for (const name of map.keys()) if (!configured.has(`${nodeName}:${name}`)) unmanaged.push(name);
    }
    ui.out(
      `\n${running}/${shown.length} running` +
        (down ? `  ${ui.paint("yellow", formatDownReasons(downReasons(rows)))}` : "") +
        (unmanaged.length
          ? `  ${ui.paint("yellow", `${unmanaged.length} unmanaged`)} ${ui.paint("dim", `(${unmanaged.slice(0, 3).join(", ")}${unmanaged.length > 3 ? ", …" : ""}) — pp adopt`)}`
          : "") +
        (config.nodes?.length ? `  ${ui.paint("dim", `${config.nodes.length} node${config.nodes.length === 1 ? "" : "s"}`)}` : "") +
        (rows.some((r) => r.reason === "hand")
          ? `  ${ui.paint("dim", "(hand) = stopped on purpose; pp up <name> brings it back")}`
          : "") +
        (rows.some((r) => r.reason === "drain")
          ? `  ${ui.paint("dim", "(drain) = machine under maintenance; pp node undrain <name> lets it start")}`
          : "") +
        (showCron ? `  ${ui.paint("dim", "cron: jobs aimed here (* = every session)")}` : "") +
        (unreachableNodes.length ? `  ${ui.paint("red", `unreachable: ${unreachableNodes.join(", ")}`)}` : "") +
        `  ${ui.paint("dim", `config: ${config.path}`)}`,
    );
  }
}

/** Rows for the sessions panel: config entries first, then live strays. */
/** How long a session may sit quiet before pp points at it (minutes). */
/**
 * Lines that showed up at the bottom of a pane since the last read.
 *
 * A pane appends at the bottom and the capture window slides up, so the old
 * tail reappears somewhere in the middle of the new capture. Two details make
 * it work on a real shell: the last line is the cursor line (a prompt that
 * repeats at the bottom), so it is set aside first; and the anchor is the
 * longest tail of "before" found in "after" — everything past it is new.
 */
export function diffLines(before, after) {
  const normalise = (text) => String(text).split("\n").map((line) => line.replace(/\s+$/, "")).filter((line) => line !== "");
  if (String(before) === String(after)) return [];
  const a = normalise(before);
  const b = normalise(after);
  const head = a.slice(0, -1); // the cursor line moves, it is not content
  const findBlock = (haystack, needle) => {
    outer: for (let i = 0; i + needle.length <= haystack.length; i += 1) {
      for (let j = 0; j < needle.length; j += 1) if (haystack[i + j] !== needle[j]) continue outer;
      return i;
    }
    return -1;
  };
  for (let len = head.length; len >= 1; len -= 1) {
    const at = findBlock(b, head.slice(head.length - len));
    if (at >= 0) {
      const added = b.slice(at + len);
      // a pane that scrolled past the whole window looks like "all new"; the
      // tail is the part worth printing
      return added.length > 40 ? added.slice(-40) : added;
    }
  }
  if (String(before) === String(after)) return [];
  return b.slice(-40);
}

/** Forget how long an agent has been busy — used when it is not busy at all. */
export function stallMinutes(env = process.env) {
  const raw = Number(env.PP_STALL_MINUTES);
  return Number.isFinite(raw) && raw > 0 ? raw : 45;
}

export function staleSeconds(env = process.env) {
  const raw = Number(env?.PP_STALE_MINUTES);
  const minutes = Number.isFinite(raw) && raw > 0 ? raw : 30;
  return minutes * 60;
}

/** "3m" for a session that last moved three minutes ago. */
function shortAge(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "";
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86400)}d`;
}

function tuiSessionRows(config, live) {
  const rows = [];
  // a session with unanswered questions looks exactly like an idle one otherwise
  const waiting = (() => {
    const counts = new Map();
    try {
      for (const todo of readTodos()) {
        if (todo.state === "done" || !todo.session) continue;
        counts.set(todo.session, (counts.get(todo.session) ?? 0) + 1);
      }
    } catch {
      return () => 0;
    }
    return (tmuxName) => counts.get(tmuxName) ?? 0;
  })();
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
    const idle = entry?.activity ? Date.now() / 1000 - entry.activity : null;
    const age = idle === null ? "" : shortAge(idle);
    const stale = idle !== null && idle >= staleSeconds() && state !== "off" && state !== "dead";
    rows.push({
      name: session.tmuxName,
      node: session.node ?? "",
      state,
      activity: entry?.activity ?? 0,
      age,
      stale,
      idleSeconds: idle === null ? null : Math.round(idle),
      todos: waiting(session.tmuxName),
      label: `${String(config.sessions.indexOf(session) + 1).padStart(2)} ${session.tmuxName}${session.node ? ` @${session.node}` : ""}  ${state}${age ? ` ${age}${stale ? " !" : ""}` : ""}${waiting(session.tmuxName) ? ` ${waiting(session.tmuxName)}?` : ""}`,
      dim: state === "off" || state === "dead",
      warn: stale,
    });
  }
  for (const [name, entry] of live) {
    if (seen.has(name)) continue;
    const state = stateOf(entry);
    const age = entry?.activity ? shortAge(Date.now() / 1000 - entry.activity) : "";
    rows.push({
      name,
      state,
      activity: entry?.activity ?? 0,
      age,
      label: ` - ${name}  ${state}${age ? ` ${age}` : ""} (not in config)`,
      dim: true,
      unmanaged: true,
    });
  }
  return rows;
}

function tuiTodoRows(todos, now) {
  return todos.map((todo, index) => ({
    name: todo.session,
    session: todo.session,
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

  // Sessions can live on other machines: merge one listing per node, remember
  // who owns each name, and hand back a tmux handle for the right machine.
  let sessionOwner = new Map();
  const readLive = () => {
    const live = new Map();
    const owner = new Map();
    for (const nodeName of [null, ...(config?.nodes ?? []).map((node) => node.name)]) {
      let map;
      try {
        map = makeTmux(config, options, { node: nodeName }).listSessions();
      } catch {
        continue;
      }
      for (const [name, entry] of map) {
        if (live.has(name)) continue;
        live.set(name, entry);
        owner.set(name, nodeName);
      }
    }
    sessionOwner = owner;
    return { live, tmuxFor: (name) => makeTmux(config, options, { node: owner.get(name) ?? null }) };
  };

  if (once) {
    const cols = process.stdout.columns || 100;
    const rows = process.stdout.rows || 30;
    const layout = computeLayout(cols, rows, { leftWidth });
    const { live } = readLive();
    const sessionRows = tuiSessionRows(config, live);
    // same drift sentence as the live panel, so --once is a fair sample
    const onceOff = sessionRows.filter((row) => row.state === "off" || row.state === "dead" || row.state === "stopped").length;
    const onceStrays = sessionRows.filter((row) => row.unmanaged).length;
    const onceDrift = [onceOff ? `${onceOff} off` : null, onceStrays ? `${onceStrays} unmanaged` : null].filter(Boolean).join(" · ");
    const model = {
      sessions: sessionRows,
      todos: tuiTodoRows(filterTodos(readTodos()), Date.now()),
      preview: { title: "—", lines: [] },
      focus: "sessions",
      footer: `${onceDrift ? `${onceDrift} · ` : ""}pp tui --once  (--left 30 adjusts the sessions column)`,
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

  // where the panel itself lives, so `pp back` can find it and so Enter cannot "attach" to itself
  let panelSession = "";
  if (process.env.TMUX) {
    const probe = tmux.run(["display-message", "-p", "#{session_name}\t#{window_index}\t#{pane_id}"], {
      allowFailure: true,
      readOnly: true,
    });
    const [session, window, pane] = String(probe.stdout ?? "").trim().split("\t");
    if (session) {
      panelSession = session;
      savePanel({ session, window, pane, pid: process.pid });
    }
  } else {
    // no tmux around us: the panel lives in this terminal, and `pp back` has to
    // detach the client instead of switching it to a pane that does not exist
    savePanel({ outside: true, pid: process.pid });
  }

  let tui = null;
  tui = createTui({
    version: options.version ?? "",
    leftWidth,
    sort: options.sort ?? "config",
    io: {
      input: process.stdin,
      output: process.stdout,
      isTTY: Boolean(process.stdin.isTTY),
      size: screenSize,
      onResize: (callback) => process.stdout.on("resize", callback),
      async refresh({ index = 0 } = {}) {
        const { live, tmuxFor } = readLive();
        const sessions = tuiSessionRows(config, live);
        const todos = tuiTodoRows(filterTodos(readTodos()), Date.now());
        const current = sessions[index]?.name ?? sessions[0]?.name;
        let preview = { title: "—", lines: ["no session selected"] };
        if (current && live.has(current)) {
          const text = tmuxFor(current).capture(current, previewLines());
          preview = { title: current, lines: text ? text.split("\n") : ["(empty pane)"] };
        }
        return { sessions, todos, preview };
      },
      async driftUp() {
        // count what the config expects and is not running, then start those
        const { live } = readLive();
        const missing = config.sessions.filter((session) => {
          if (session.restart === "no") return false;
          if (live.has(session.name)) return false;
          if (isStopped(config.path, session.name)) return false;
          return true;
        });
        if (!missing.length) return 0;
        let started = 0;
        for (const session of missing) {
          const handle = makeTmux(config, options, session);
          try {
            if (handle.sessionExists(session.tmuxName)) continue;
            prepareSession(session, options);
            handle.create(session, launchSpec(session, handle));
            markStarted(config.path, session.name, { why: "panel", by: auditActor(process.env) });
            markRestart(config.path, session.name, { why: "panel", by: auditActor(process.env) });
            started++;
            note("up", session.name, { node: session.node ?? null, detail: "panel drift", result: "ok" });
          } catch (error) {
            tui?.noteFromAttach(`could not start ${session.name}: ${error.message}`);
          }
        }
        return started;
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
        if (!name) {
          tui?.noteFromAttach("that row has no session — press r to refresh the lists");
          return;
        }
        if (panelSession && name === panelSession) {
          tui?.noteFromAttach(`${name} is this panel — Tab switches panels, q quits, d closes a todo`);
          return;
        }
        // the session may live on another machine: ask the machine that owns it
        const handle = makeTmux(config, options, { node: sessionOwner.get(name) ?? null });
        if (!handle.sessionExists(name)) {
          // no ui.warn here: printing into a live alt screen tears the frame
          tui?.noteFromAttach(`${name} is not running — start it with: pp up ${name}`);
          return;
        }
        if (handle.remote) {
          // You cannot point a local tmux client at a remote session, so the
          // panel hands its own terminal to ssh and gets it back on detach.
          const status = handle.attach(name);
          if (status !== 0) tui?.noteFromAttach(`could not attach to ${name} on ${handle.remote.node.name} — exited ${status}`);
          return;
        }
        if (process.env.TMUX) {
          const clients = tmux.listClients?.() ?? [];
          const client = clients.sort((a, b) => b.activity - a.activity)[0];
          if (!client) {
            tui?.noteFromAttach("no attached tmux client to switch — run `tmux attach` in a terminal, then press Enter");
            return;
          }
          const res = tmux.run(["switch-client", "-c", client.name, "-t", `=${name}`], { allowFailure: true });
          if ((res.status ?? 1) !== 0) {
            // silence here looked like "it goes in and comes straight back out"
            const why = String(res.stderr ?? "").trim().split("\n")[0] || `tmux exited ${res.status}`;
            tui?.noteFromAttach(`could not switch to ${name}: ${why}`);
            return;
          }
          // the client is gone from the panel now: tell it, on its own status line, how to come back
          tmux.run(["display-message", "-c", client.name, `panel is behind you — \`pp back\` (or /pp-back) returns`], {
            allowFailure: true,
          });
          return;
        }
        const status = tmux.attach(name);
        if (status !== 0) tui?.noteFromAttach(`tmux attach ${name} exited ${status} — is ${name} still running?`);
      },
    },
  });
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
/**
 * The panel is a plain terminal outside tmux (ssh, iTerm2, …). There is no pane
 * to switch to, so "back to the panel" means dropping this client — the outer
 * terminal then shows the panel again.
 */
function backToOutsidePanel(tmux, panel, options, ui) {
  const where = panel.pid ? ` (pid ${panel.pid})` : "";
  if (options.dryRun) {
    ui.info(`[dry-run] tmux detach-client   # the panel${where} is outside tmux`);
    return 0;
  }
  if (!process.env.TMUX) {
    ui.info(`the panel${where} is running in another terminal — nothing to switch to here`);
    return 0;
  }
  const me = String(
    tmux.run(["display-message", "-p", "#{session_name}"], { allowFailure: true, readOnly: true }).stdout ?? "",
  ).trim();
  const clients = tmux.listClients?.() ?? [];
  const attached = clients.filter((client) => client.session === me).sort((a, b) => b.activity - a.activity);
  const client = attached[0]?.name ?? "";
  const res = client
    ? tmux.run(["detach-client", "-t", client], { allowFailure: true })
    : tmux.run(["detach-client", "-s", me], { allowFailure: true });
  if ((res.status ?? 1) !== 0) {
    ui.error(String(res.stderr ?? "").trim() || "could not detach");
    process.exit(1);
  }
  ui.info(`detached from ${me || "this session"} — the panel is back in your terminal${where}`);
  return 0;
}

async function cmdBack(config, options, ui) {
  const tmux = makeTmux(config, options);
  const panel = loadPanel();
  if (!panel) {
    ui.error("no panel remembered — start one with: pp tui");
    process.exit(1);
  }
  if (!panelAlive(panel)) {
    clearPanel();
    ui.error("the panel is gone — start a new one with: pp tui");
    process.exit(1);
  }
  if (panel.outside) return backToOutsidePanel(tmux, panel, options, ui);
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
  const tmux = makeTmux(config, options, session);
  if (options.dryRun) {
    ui.info(`[dry-run] ${tmux.args(["attach-session", "-t", `=${session.tmuxName}`]).join(" ")}`);
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

/**
 * Keep the lines that match, plus `context` lines around each, joined with `…`
 * where something was skipped -- the shape `grep -C` has, which is what people
 * already know. Returns the text and how many lines matched (not how many were
 * printed), so "did it fail the same way" is one number.
 */
export function grepLines(text, pattern, { context = 0, ignoreCase = false } = {}) {
  const re = new RegExp(pattern, ignoreCase ? "i" : "");
  const lines = String(text ?? "").replace(/\n$/, "").split("\n");
  const keep = new Set();
  let matches = 0;
  lines.forEach((line, index) => {
    if (!re.test(line)) return;
    matches += 1;
    for (let at = Math.max(0, index - context); at <= Math.min(lines.length - 1, index + context); at += 1) keep.add(at);
  });
  const out = [];
  let previous = -2;
  for (const index of [...keep].sort((a, b) => a - b)) {
    if (index > previous + 1) out.push("…");
    out.push(lines[index]);
    previous = index;
  }
  return { text: out.join("\n"), matches };
}

function cmdLogs(config, options, ui) {
  const names = (options.names ?? []).filter((name) => name !== undefined);
  if (names.length === 0 && !options.all) {
    ui.error("usage: pp logs <name...> [--lines N] [--follow]   (or --all)");
    process.exit(2);
  }
  // --all means all of them, including the ones whose restart policy says
  // "do not touch" — reading a pane is not touching it
  const sessions = options.all ? config.sessions : names.flatMap((name) => selectSessions(config, [name], ui));
  if (sessions.length === 0) {
    ui.error("nothing to show");
    process.exit(1);
  }
  const lines = options.lines ?? 200;
  // validate the filter once, not per session: a bad regex would otherwise
  // surface as a stack trace halfway through a multi-machine read
  const context = options.context === undefined ? 0 : Number(options.context);
  if (!Number.isInteger(context) || context < 0) {
    ui.error("--context takes a number of lines, e.g. --context 2");
    process.exit(2);
  }
  if (options.grep !== undefined) {
    try {
      new RegExp(options.grep, options.ignoreCase ? "i" : "");
    } catch (error) {
      ui.error(`--grep is not a valid pattern: ${error.message}`);
      process.exit(2);
    }
  }
  const labelled = sessions.length > 1;
  const handles = new Map();
  const handleFor = (session) => {
    const key = session.node ?? "local";
    if (!handles.has(key)) handles.set(key, makeTmux(config, options, session));
    return handles.get(key);
  };

  if (options.dryRun) {
    for (const session of sessions) {
      const tmux = handleFor(session);
      ui.info(`[dry-run] ${tmux.args(["capture-pane", "-p", "-t", `=${session.tmuxName}:`, "-S", `-${lines}`]).join(" ")}`);
    }
    return;
  }

  // tmux does not record when a program wrote a line, only what is on screen.
  // So --stamp prints when *pp* saw the line: for a snapshot that is the capture
  // time, while following it is the time the line appeared (within --interval).
  const stamp = () => {
    const now = new Date();
    const pad = (value) => String(value).padStart(2, "0");
    return `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())} `;
  };
  // the previous batch's last line can come back as "new" (it was the cursor
  // line when the last capture happened), so remember what was already printed
  const lastOut = new Map();
  const stamped = (text, when = stamp()) =>
    String(text)
      .replace(/\n$/, "")
      .split("\n")
      .map((line) => `${ui.paint("dim", when)}${line}`)
      .join("\n");

  let failures = 0;
  let matched = 0;
  for (const session of sessions) {
    const tmux = handleFor(session);
    if (!tmux.sessionExists(session.tmuxName)) {
      ui.error(`session "${session.name}" is not running${session.node ? ` on ${session.node}` : ""}`);
      failures += 1;
      continue;
    }
    if (labelled) process.stdout.write(`\n${ui.paint("bold", `── ${session.name}${session.node ? ` @${session.node}` : ""} ` + "─".repeat(Math.max(0, 20 - session.name.length)))}\n`);
    const output = tmux.capture(session.tmuxName, lines);
    const lastLine = output.replace(/\n$/, "").split("\n").filter((line) => line.trim()).pop();
    if (lastLine) lastOut.set(session.name, lastLine);
    if (options.grep) {
      const found = grepLines(output, options.grep, { context, ignoreCase: options.ignoreCase });
      matched += found.matches;
      if (!found.text) continue;
      process.stdout.write(`${options.stamp ? stamped(found.text) : found.text}\n`);
      continue;
    }
    if (options.stamp) {
      process.stdout.write(`${stamped(output)}\n`);
    } else {
      process.stdout.write(output.endsWith("\n") ? output : `${output}\n`);
    }
  }
  if (failures) process.exitCode = 1;
  if (options.grep) {
    // grep semantics: nothing found is a failure, so this composes in a script
    if (!matched) {
      if (!options.quiet) process.stderr.write(ui.paint("dim", `no line matches ${JSON.stringify(options.grep)}\n`));
      process.exitCode = 1;
    } else if (!options.quiet) {
      process.stderr.write(ui.paint("dim", `${matched} match${matched === 1 ? "" : "es"}\n`));
    }
  }
  // --follow: re-read each pane on an interval and print what is new, so one
  // terminal can watch a whole machine park instead of one tmux window per tab.
  if (!options.follow) return;
  const seen = new Map(sessions.map((session) => [session.name, handleFor(session).sessionExists(session.tmuxName) ? handleFor(session).capture(session.tmuxName, lines) : ""]));
  const interval = Number(options.interval ?? 2) * 1000;
  process.stderr.write(ui.paint("dim", `following ${sessions.length} session(s), ctrl-c to stop\n`));
  const timer = setInterval(() => {
    for (const session of sessions) {
      const tmux = handleFor(session);
      if (!tmux.sessionExists(session.tmuxName)) continue;
      const now = tmux.capture(session.tmuxName, lines);
      const before = seen.get(session.name) ?? "";
      if (now === before) continue;
      seen.set(session.name, now);
      let added = diffLines(before, now);
      if (!added.length) continue;
      if (options.grep) added = grepLines(added.join("\n"), options.grep, { context: 0, ignoreCase: options.ignoreCase }).text.split("\n").filter((line) => line && line !== "…");
      if (!added.length) continue;
      if (added[0] === lastOut.get(session.name)) added.shift();
      if (!added.length) continue;
      lastOut.set(session.name, added[added.length - 1]);
      const when = stamp();
      const body = options.stamp ? stamped(added.join("\n"), when) : added.join("\n");
      // with one session the name is noise, with several it is the only way to
      // tell the timelines apart
      const head = options.stamp && sessions.length === 1 ? "" : `${ui.paint("dim", `[${session.name}${session.node ? ` @${session.node}` : ""}]`)} `;
      process.stdout.write(`${head}${body}\n`);
    }
  }, interval);
  process.on("SIGINT", () => {
    clearInterval(timer);
    process.exit(0);
  });
}

function cmdSend(config, options, ui) {
  // --all: one sentence into every session, the same fan-out pp cron uses.
  // Busy sessions are skipped on purpose: queueing a second prompt into an
  // agent that is mid-turn is how you get it to lose the thread.
  if (options.all || options.tags?.length || options.node) {
    if (options.names.length < 1) {
      ui.error('usage: pp send --all "text" [--dry-run]');
      process.exit(2);
    }
    const text = options.names.join(" ");
    const sessions = selectSessions(config, [], ui, { all: true, options });
    if (!sessions.length) {
      ui.error("no session matched that filter");
      process.exitCode = 1;
      return;
    }
    if (options.dryRun) {
      for (const session of sessions) {
        const tmux = makeTmux(config, options, session);
        ui.info(`[dry-run] ${tmux.args(["send-keys", "-t", `=${session.tmuxName}:`, "--", text]).join(" ")}${options.noEnter ? "" : " Enter"}`);
      }
      return;
    }
    let sent = 0;
    let busy = 0;
    for (const session of sessions) {
      const tmux = makeTmux(config, options, session);
      if (!tmux.sessionExists(session.tmuxName)) continue;
      if (tmux.isAgentBusy(session.tmuxName)) {
        busy++;
        ui.info(`${ui.paint("dim", "busy")}    ${session.tmuxName} — skipped, it is mid-turn`);
        continue;
      }
      const result = tmux.sendText(session.tmuxName, text, { enter: !options.noEnter });
      if (result.submitted || options.noEnter) sent++;
      else ui.warn(`${session.tmuxName}: the text is in the box but Enter never took it`);
      note("send", session.name, { node: session.node ?? null, detail: text.slice(0, 120), result: result.submitted ? "sent" : "typed" });
    }
    ui.info(`\n${sent} sent, ${busy} busy, ${sessions.length - sent - busy} not running`);
    if (sent === 0 && busy === 0) process.exitCode = 1;
    return;
  }
  const [name, ...rest] = options.names;
  if (!name || rest.length === 0) {
    ui.error('usage: pp send <name> "text" [--no-enter]');
    process.exit(2);
  }
  const [session] = selectSessions(config, [name], ui);
  const tmux = makeTmux(config, options, session);
  const text = rest.join(" ");
  if (options.dryRun) {
    ui.info(`[dry-run] ${tmux.args(["send-keys", "-t", `=${session.tmuxName}:`, "--", text]).join(" ")}${options.noEnter ? "" : " Enter"}`);
    return;
  }
  if (!tmux.sessionExists(session.tmuxName)) {
    ui.error(`session "${session.name}" is not running`);
    process.exit(1);
  }
  tmux.sendText(session.tmuxName, text, { enter: !options.noEnter });
  note("send", session.name, { node: session.node ?? null, detail: text.length > 120 ? `${text.slice(0, 117)}…` : text, result: options.noEnter ? "typed" : "sent" });
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
  const sessions = selectSessions(config, options.names, ui, { all: true, options });
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

/**
 * One reading of "is this agent working, and is the screen still changing?".
 *
 * Total busy time is a poor signal: a 40-minute build is not stuck. A working
 * agent keeps redrawing (spinner, counters, tool output); a hung one redraws
 * nothing, so the pane is byte-identical frame after frame. We remember the last
 * signature we saw and when, and report how long it has been quiet.
 */
export function stallWatch(config, tmux, session, { env = process.env, now = Date.now() } = {}) {
  let text = "";
  try {
    text = tmux.capture(session.tmuxName, 40);
  } catch {
    return null;
  }
  if (!looksBusy(text)) {
    clearBusy(config.path, session.name, env);
    clearActivity(config.path, session.name, env);
    return { name: session.name, busy: false, quiet: 0 };
  }
  const sinceBusy = busySinceOf(config.path, session.name, env) ?? markBusy(config.path, session.name, env, new Date(now).toISOString());
  const signature = screenSignature(text);
  const previous = activityOf(config.path, session.name, env);
  if (!previous || previous.sig !== signature) {
    noteActivity(config.path, session.name, { at: new Date(now).toISOString(), sig: signature }, env);
    return { name: session.name, busy: true, quiet: 0, busyMinutes: Math.round((now - Date.parse(sinceBusy)) / 60000) };
  }
  return {
    name: session.name,
    busy: true,
    quiet: Math.max(0, Math.round((now - Date.parse(previous.at)) / 60000)),
    busyMinutes: Math.round((now - Date.parse(sinceBusy)) / 60000),
  };
}

const CLEAN_KEEP_BYTES = 2 * 1024 * 1024;
const LOG_WARN_BYTES = 50 * 1024 * 1024;

/** "512k", "2m", "1g", "1048576" -> bytes. No unit means bytes. */
export function parseSize(text) {
  const raw = String(text ?? "").trim().toLowerCase();
  const match = /^(\d+(?:\.\d+)?)\s*(b|k|kb|m|mb|g|gb)?$/.exec(raw);
  if (!match) throw new Error(`"${text}" is not a size (try 512k, 2m, 1g)`);
  const units = { b: 1, k: 1024, kb: 1024, m: 1024 ** 2, mb: 1024 ** 2, g: 1024 ** 3, gb: 1024 ** 3 };
  return Math.round(Number(match[1]) * (units[match[2] ?? "b"] ?? 1));
}

export function humanBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  return `${(value / 1024 ** 3).toFixed(1)} GB`;
}

/**
 * Cut a file down to its last `keep` bytes, in place.
 *
 * In place, not "write a new file and rename": a `log:` session runs
 * `pipe-pane ... cat >> file`, and that writer holds an open append fd. Renaming
 * would leave it writing into an unlinked inode while the new file stays empty --
 * the log looks alive and is silently lost. With O_APPEND, truncating the same
 * inode just moves the end of file, so the writer keeps appending where we left off.
 */
export function shrinkTail(path, keep) {
  const before = statSync(path).size;
  if (before <= keep) return { before, after: before, freed: 0 };
  const fd = openSync(path, "r+");
  try {
    const buffer = Buffer.allocUnsafe(keep);
    const read = readSync(fd, buffer, 0, keep, before - keep);
    // start on a line boundary when we can: half a log line reads as corruption
    let start = 0;
    const newline = buffer.subarray(0, Math.min(read, 4096)).indexOf(0x0a);
    if (newline >= 0) start = newline + 1;
    writeSync(fd, buffer, start, read - start, 0);
    ftruncateSync(fd, read - start);
    return { before, after: read - start, freed: before - (read - start) };
  } finally {
    closeSync(fd);
  }
}

/**
 * Every file pp itself makes grow forever: a session's `log:`, plus the state
 * logs (info/cron/audit). Nothing rotates them, so on a busy pact they fill the
 * disk and the first symptom is everything failing to write at 3am.
 */
export function logTargets(config, env = process.env) {
  const targets = [];
  for (const session of config.sessions) {
    if (!session.log || session.node) continue;
    targets.push({ path: session.log, label: session.name });
  }
  const dir = stateDir(env);
  for (const name of ["info.log", "cron.log", "audit.log", "audit.log.1"]) {
    targets.push({ path: join(dir, name), label: name });
  }
  return targets;
}

async function cmdClean(config, options, ui) {
  let keep = CLEAN_KEEP_BYTES;
  if (options.keep !== undefined) {
    try {
      keep = parseSize(options.keep);
    } catch (error) {
      ui.error(error.message);
      process.exit(2);
    }
  }
  const rows = [];
  for (const target of logTargets(config, process.env)) {
    if (!existsSync(target.path)) continue;
    const size = statSync(target.path).size;
    if (size <= keep) continue;
    const shrunk = options.dryRun ? { before: size, after: keep, freed: size - keep } : shrinkTail(target.path, keep);
    rows.push({ ...target, ...shrunk });
  }
  const remoteLogs = config.sessions.filter((session) => session.log && session.node).length;
  const freed = rows.reduce((sum, row) => sum + row.freed, 0);

  if (options.json) {
    ui.out(JSON.stringify({ keep, freed, files: rows, remote: remoteLogs }, null, 2));
  } else if (!rows.length) {
    ui.out(`nothing to shrink — no log is bigger than ${humanBytes(keep)}`);
  } else {
    for (const row of rows) {
      ui.out(
        `${options.dryRun ? "would shrink" : "shrank"} ${ui.paint("cyan", row.label)}  ` +
          `${humanBytes(row.before)} → ${humanBytes(row.after)}  ${ui.paint("dim", row.path)}`,
      );
    }
    ui.out(`\n${humanBytes(freed)} freed${options.dryRun ? " (dry run: nothing written)" : ""}`);
  }
  if (remoteLogs) {
    ui.out(ui.paint("dim", `${remoteLogs} remote log(s) are not touched from here — run pp clean on that machine`));
  }
}

async function cmdCheck(config, options, ui) {
  const tmux = makeTmux(config, options);
  const problems = [];
  const notes = [];
  const seenCwd = new Map();

  for (const session of config.sessions) {
    context: {
      // a remote session's cwd lives on the node; checking it here would only
      // produce false alarms (or worse, hide a real one behind them)
      if (session.node) break context;
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

  // A remote session's cwd lives on the node. Checking it here would only
  // produce false alarms, but never checking it means a typo in a path is
  // discovered at 3am. `--remote` asks the machines, once per node.
  const remoteSessions = config.sessions.filter((session) => session.node);
  if (remoteSessions.length) {
    if (!options.remote) {
      notes.push(
        `${remoteSessions.length} remote session(s) not checked here — pp check --remote asks the machines`,
      );
    } else {
      const byNode = new Map();
      for (const session of remoteSessions) {
        const list = byNode.get(session.node) ?? [];
        list.push(session);
        byNode.set(session.node, list);
      }
      // one ssh round trip per node: six machines in parallel is ~1 handshake,
      // serially it is six seconds of watching nothing happen
      const jobs = [];
      const collect = (nodeName, node, list) => {
        if (!node) {
          problems.push(`node "${nodeName}" is not defined under "nodes"`);
          return;
        }
        const script = list
          .map((session) => {
            const dir = shellQuote(session.cwd);
            const agent = shellQuote(session.agent[0]);
            return (
              `if [ -d ${dir} ]; then echo "ok ${session.name}"; ` +
              `else echo "nocwd ${session.name} ${session.cwd}"; fi; ` +
              `command -v ${agent} >/dev/null 2>&1 || echo "noagent ${session.name} ${session.agent[0]}"`
            );
          })
          .join("; ");
        jobs.push({ nodeName, node, script, list });
      };
      for (const [nodeName, list] of byNode) {
        collect(nodeName, config.nodes?.find((entry) => entry.name === nodeName), list);
      }
      const results = await Promise.all(
        jobs.map(async (job) => ({ job, probe: await runOnNodeAsync(job.node, [job.script], { timeout: 25000 }) })),
      );
      for (const { job, probe } of results) {
        const nodeName = job.nodeName;
        if (probe.error) {
          problems.push(`node "${nodeName}" unreachable — ${probe.error.message}`);
          continue;
        }
        if (probe.status !== 0 && !String(probe.stdout ?? "").trim()) {
          const why = String(probe.stderr ?? "").trim().split("\n")[0] || `exit ${probe.status}`;
          problems.push(`node "${nodeName}" unreachable — ${why}`);
          continue;
        }
        for (const line of String(probe.stdout ?? "").trim().split("\n")) {
          const [kind, name, detail] = line.split(" ");
          if (kind === "nocwd") problems.push(`"${name}": cwd does not exist on ${nodeName}: ${detail}`);
          if (kind === "noagent") problems.push(`"${name}": agent "${detail}" not found on ${nodeName}`);
        }
        const stderr = String(probe.stderr ?? "").trim();
        if (probe.status !== 0 && stderr) problems.push(`node "${nodeName}": ${stderr.split("\n")[0]}`);
      }
    }
  }

  if (options.brief) {
    // one line and an exit code: this is the shape a release script wants
    const nodes = config.nodes?.length ?? 0;
    if (problems.length === 0) {
      ui.out(`ok ${config.sessions.length} session(s), ${nodes} node(s), 0 problems`);
    } else {
      const more = problems.length > 1 ? ` (+${problems.length - 1} more)` : "";
      ui.error(`${problems.length} problem${problems.length === 1 ? "" : "s"}: ${problems[0]}${more} — pp check`);
    }
  } else if (ui.json) {
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

/** The copy of this package that pi's extension host loads (pi install npm:pi-farm). */
export function installedExtension(env = process.env) {
  const base = env.PP_EXT_DIR ?? join(env.HOME ?? homedir(), ".pi", "agent", "npm", "node_modules", "pi-farm");
  try {
    const pkg = JSON.parse(readFileSync(join(base, "package.json"), "utf8"));
    return { dir: base, version: String(pkg.version ?? "?") };
  } catch {
    return null;
  }
}

function ownVersion() {
  try {
    return String(JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version ?? "?");
  } catch {
    return "?";
  }
}

function describeExtension(installed, own) {
  if (!installed) return "not installed — pi install npm:pi-farm  (needed for /pp-* commands)";
  if (installed.version !== own) {
    return `${installed.version} but this cli is ${own} — npm install --prefix ${dirname(installed.dir)} pi-farm@${own} --registry https://registry.npmjs.org/`;
  }
  return `pi-farm@${installed.version} in ${installed.dir}`;
}

async function doctorNodes(config, options, ui) {
  const nodes = taggedNodes(config, options);
  if (!nodes.length) {
    const hint = options.node || options.tags?.length
      ? "no machine matched that filter — see: pp node ls"
      : "no machines registered — see: pp node add --help";
    ui.error(hint);
    process.exitCode = 1;
    return;
  }
  const results = await Promise.all(
    nodes.map(async (node) => {
      const started = Date.now();
      try {
        const res = await runOnNodeAsync(node, [PROBE_SCRIPT], { timeout: 15000 });
        const ms = Date.now() - started;
        if (res.status !== 0) {
          return { node, ok: false, ms, error: (res.stderr || res.stdout || `ssh exited ${res.status}`).trim().split("\n")[0] };
        }
        return { node, ok: true, ms, probe: parseProbe(res.stdout) };
      } catch (error) {
        return { node, ok: false, ms: Date.now() - started, error: error.message };
      }
    }),
  );

  // What the config expects on that machine vs what is actually running there.
  const driftOf = (node, probe) => {
    const expected = config.sessions.filter((session) => session.node === node.name);
    const live = String(probe?.session_names ?? "").split(/\s+/).filter(Boolean);
    const liveSet = new Set(live);
    const mine = new Set(expected.map((session) => session.tmuxName));
    return {
      up: expected.filter((session) => liveSet.has(session.tmuxName)).length,
      total: expected.length,
      missing: expected.filter((session) => !liveSet.has(session.tmuxName) && session.restart !== "no").map((session) => session.name),
      stray: live.filter((name) => !mine.has(name)),
    };
  };
  for (const result of results) if (result.ok) result.drift = driftOf(result.node, result.probe);

  const usable = results.filter((r) => r.ok);
  const carrying = usable.filter((r) => Number(r.probe?.sessions ?? 0) > 0).length;
  const slowest = usable.length ? Math.max(...usable.map((r) => r.ms)) : 0;

  if (ui.json) {
    ui.out(
      JSON.stringify(
        results.map((r) => ({
          name: r.node.name,
          target: nodeTarget(r.node),
          ok: r.ok,
          ms: r.ms,
          error: r.ok ? null : r.error,
          ...(r.ok ? { probe: r.probe, drift: r.drift ?? null } : {}),
        })),
        null,
        2,
      ),
    );
    if (!usable.length || results.some((r) => !r.ok)) process.exitCode = 1;
    return;
  }

  // /proc/uptime is seconds and /proc/loadavg is three numbers: say what an
  // operator can read at a glance, not what the kernel happened to print
  const upText = (seconds) => {
    const value = Number(seconds);
    if (!Number.isFinite(value) || value <= 0) return "-";
    return value >= 86400 ? `${Math.floor(value / 86400)}d` : `${Math.floor(value / 3600)}h`;
  };
  // "3/4" reads as "three of the four I expect are up"; " +1" is a session
  // nobody wrote down. Both are the reason to open an editor or run pp adopt.
  const driftText = (r) => {
    if (!r.ok || !r.drift) return "-";
    const { up, total, missing, stray } = r.drift;
    if (total === 0 && stray.length === 0) return ui.paint("dim", "-");
    const parts = [];
    if (total > 0) parts.push(missing.length ? ui.paint("yellow", `${up}/${total}`) : ui.paint("green", `${up}/${total}`));
    if (stray.length) parts.push(ui.paint("yellow", `+${stray.length}`));
    return parts.join(" ");
  };
  const rows = results.map((r) => [
    `${r.ok ? ui.paint("green", "✓") : ui.paint("red", "✗")} ${r.node.name}`,
    nodeTarget(r.node),
    r.ok ? `${r.ms}ms` : ui.paint("red", "down"),
    r.ok ? (r.probe?.tmux && r.probe.tmux !== "-" ? r.probe.tmux.replace(/^tmux\s+/, "") : "-") : "-",
    r.ok ? String(r.probe?.load ?? "-").split(/\s+/)[0] : "-",
    r.ok ? upText(r.probe?.up) : "-",
    r.ok ? String(r.probe?.sessions ?? "-") : "-",
    r.ok ? r.probe?.disk ?? "-" : "-",
    r.ok ? r.probe?.mem ?? "-" : "-",
    driftText(r),
  ]);
  const headers = ["MACHINE", "TARGET", "PING", "TMUX", "LOAD", "UP", "SESSIONS", "DISK", "MEM", "CONFIG"];
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((row) => stripAnsi(row[i]).length)));
  const pad = (value, width) => value + " ".repeat(Math.max(0, width - stripAnsi(value).length));
  ui.out(ui.paint("bold", headers.map((h, i) => pad(h, widths[i])).join("  ").trimEnd()));
  for (const row of rows) ui.out(row.map((cell, i) => pad(cell, widths[i])).join("  ").trimEnd());

  for (const bad of results.filter((r) => !r.ok)) ui.out(ui.paint("dim", `  ${bad.node.name}: ${bad.error}`));
  ui.out(
    `\n${usable.length}/${results.length} reachable` +
      (usable.length ? `  ${carrying} carrying sessions  slowest ${slowest}ms` : ""),
  );
  if (results.some((r) => !r.ok)) process.exitCode = 1;
}

function cmdDoctor(config, options, ui) {
  // the machine park, not this machine: a different question, a different table
  if (options.nodes) return doctorNodes(config, options, ui);
  const tmux = makeTmux(config, options);
  const checks = [];
  // `fix` is the command that makes the check pass: at 3am "what do I type" beats
  // "what is wrong", and `--brief` is built out of these.
  const add = (label, ok, detail, fix = null) => checks.push({ label, ok, detail, fix });

  add("node", true, process.version);
  const tmuxVersion = (() => {
    try {
      return tmux.run(["-V"], { readOnly: true }).stdout.trim();
    } catch {
      return null;
    }
  })();
  add("tmux", Boolean(tmuxVersion), tmuxVersion ?? "not found", "install tmux (apt install tmux)");
  const hasServer = tmux.hasServer();
  // A missing server is normal (tmux starts on demand) — not a failure.
  add("tmux server", true, hasServer ? "running" : "not running (starts on demand)");
  add("pi", commandExists("pi"), resolveExecutable("pi"), "npm i -g @earendil-works/pi-coding-agent");
  const extension = installedExtension();
  const own = ownVersion();
  add(
    "pi extension",
    Boolean(extension) && extension.version === own,
    describeExtension(extension, own),
    `npm install --prefix ~/.pi/agent/npm pi-farm@${own} --registry https://registry.npmjs.org/`,
  );
  const names = inspectCommandNames({ target: scriptPath(options) });
  add("command name", names.ok, describeCommandNames(names), "pp alias add pif");
  // The scheduler is the quietest thing to break: jobs simply stop firing and
  // nothing says so. One line here is the difference between noticing and not.
  {
    const jobs = readJobs();
    let ticked = false;
    try {
      ticked = crondHasBlock(readCrontab());
    } catch {
      ticked = false;
    }
    const lastTick = jobs.reduce((newest, job) => Math.max(newest, Date.parse(job.lastRun ?? "") || 0), 0);
    const ageMinutes = lastTick ? Math.round((Date.now() - lastTick) / 60000) : null;
    const overdue = overdueJobs(jobs);
    const detail = !jobs.length
      ? "no jobs — pp cron add --every 10m \"…\""
      : overdue.length
        ? `${overdue[0].id} is ${overdue[0].late} late — pp cron run ${overdue[0].id}` +
          (overdue.length > 1 ? ` (+${overdue.length - 1} more)` : "")
        : `${jobs.length} job${jobs.length === 1 ? "" : "s"}, tick ${ticked ? "installed" : "not installed"}` +
          (ageMinutes === null ? "" : `, last fired ${ageMinutes}m ago`);
    const healthy =
      !jobs.length || (ticked && (ageMinutes === null || ageMinutes < 60) && overdue.length === 0);
    add("cron", healthy, detail, overdue.length ? `pp cron run ${overdue[0].id}` : "pp install");
  }
  add("config", Boolean(config), config?.path ?? "not found", "pp init");
  if (config?.nodes?.length) {
    // Registering a machine is a promise; say whether ssh can keep it, but do
    // not spend a round trip per node without being asked.
    const used = new Set(config.sessions.filter((s) => s.node).map((s) => s.node));
    add(
      "nodes",
      true,
      `${config.nodes.length} registered (${[...used].join(", ") || "none"} carrying sessions) — one-shot tour: pp doctor --nodes`,
    );
  }
  if (config) {
    // Does the config still describe this machine? Two drifts matter: parked
    // sessions that should be up, and live ones nobody wrote down.
    const live = tmux.listSessions();
    const local = config.sessions.filter((session) => !session.node);
    const mine = new Set(local.map((session) => session.tmuxName));
    const parked = local.filter((session) => !live.has(session.tmuxName) && session.restart !== "no").map((session) => session.name);
    const strays = [...live.keys()].filter((name) => !mine.has(name));
    add(
      "drift",
      parked.length === 0 && strays.length === 0,
      [parked.length ? `off: ${parked.join(", ")} — pp up` : null, strays.length ? `not in config: ${strays.join(", ")} — pp adopt` : null]
        .filter(Boolean)
        .join(" · ") || "nothing off, nothing unmanaged",
      parked.length ? "pp up --drift" : strays.length ? "pp adopt" : null,
    );
  }
  if (config) {
    // "Which agent is stuck?" is the question nobody can answer from `ps`: a pi
    // turn that has been open for hours looks exactly like a busy one, and the
    // only difference is how long we have seen it busy.
    const limitMinutes = stallMinutes(process.env);
    const live = tmux.listSessions();
    const stuck = [];
    const seen = [];
    for (const session of config.sessions.filter((s) => !s.node)) {
      if (!live.has(session.tmuxName)) {
        // a session that is not running cannot be stuck; forgetting the clock
        // matters, or the next start inherits a stale "busy 3h"
        clearBusy(config.path, session.name);
        continue;
      }
      const watch = stallWatch(config, tmux, session);
      if (!watch || !watch.busy) continue;
      seen.push({ name: session.name, quiet: watch.quiet, busyMinutes: watch.busyMinutes });
      if (watch.quiet >= limitMinutes) stuck.push({ name: session.name, quiet: watch.quiet, busyMinutes: watch.busyMinutes });
    }
    const longestQuiet = seen.reduce((most, entry) => Math.max(most, entry.quiet), 0);
    // nothing rotates a `log:` file or the state logs: the first symptom of a
    // full disk is everything failing to write, which reads like a pp bug
    const logs = logTargets(config, process.env)
      .filter((target) => existsSync(target.path))
      .map((target) => ({ ...target, size: statSync(target.path).size }))
      .filter((target) => target.size > LOG_WARN_BYTES)
      .sort((a, b) => b.size - a.size);
    add(
      "logs",
      logs.length === 0,
      logs.length
        ? `${logs.map((e) => `${e.label} ${humanBytes(e.size)}`).join(", ")} — shrink: pp clean`
        : "no log file is close to the disk (limit 50 MB each)",
      logs.length ? "pp clean" : null,
    );
    add(
      "stalls",
      stuck.length === 0,
      stuck.length
        ? `${stuck.map((e) => `${e.name} no new output for ${e.quiet}m (busy ${e.busyMinutes}m)`).join(", ")} — look: pp logs <name> (PP_STALL_MINUTES=${limitMinutes})`
        : seen.length
          ? `no agent stuck (quietest ${longestQuiet}m, limit ${limitMinutes}m)`
          : "no agent working right now",
      stuck.length ? `pp logs ${stuck[0].name}` : null,
    );
  }
  const autostart = autostartState();
  add(
    "autostart",
    Boolean(autostart.kind) && autostart.installed && autostart.enabled,
    describeAutostart(autostart),
    "pp install",
  );
  if (isWsl()) {
    // On WSL the distro only runs after Windows starts it; systemd alone cannot help.
    add("wsl", true, "Windows 侧需触发（任务计划/启动项），见 pp install 提示");
  }

  // Order by "how much does this unblock": without a config nothing else matters,
  // then the basics pp runs on, then the quiet breakages. A hung agent is last:
  // it needs a human to look, not a command.
  const PRIORITY = [
    "config",
    "node",
    "tmux",
    "pi",
    "command name",
    "pi extension",
    "autostart",
    "cron",
    "drift",
    "logs",
    "stalls",
    "tmux server",
    "wsl",
  ];
  const rank = (label) => (PRIORITY.includes(label) ? PRIORITY.indexOf(label) : PRIORITY.length);
  const failed = checks.filter((check) => !check.ok).sort((a, b) => rank(a.label) - rank(b.label));

  if (options.brief) {
    if (!failed.length) {
      ui.out(`ok ${checks.length} checks, nothing to do`);
      return;
    }
    const [first, ...rest] = failed;
    const say = (check, prefix) =>
      `${prefix} ${check.fix ? ui.paint("bold", check.fix) : check.detail} ${ui.paint("dim", `— ${check.label}: ${check.detail}`)}`;
    ui.out(say(first, "first:"));
    if (rest.length) ui.out(say(rest[0], "then: "));
    const more = failed.length - (rest.length ? 2 : 1);
    ui.out(ui.paint("dim", `${failed.length} of ${checks.length} checks need attention${more > 0 ? ` (${more} more)` : ""} — pp doctor`));
    process.exitCode = 1;
    return;
  }

  if (ui.json) {
    ui.out(JSON.stringify({ checks, failed: failed.map((c) => c.label), warnings: config?.warnings ?? [] }, null, 2));
    // same contract as the table: a failing check is a failing run
    if (failed.length) process.exitCode = 1;
    return;
  }
  for (const check of checks) {
    const mark = check.ok ? ui.paint("green", "✓") : ui.paint("red", "✗");
    ui.out(`${mark} ${check.label.padEnd(14)} ${ui.paint("dim", check.detail ?? "")}`);
  }
  if (!config) ui.out(`\n${ui.paint("dim", "hint:")} no config found; run pp init`);
  if (!extension || extension.version !== own) {
    ui.out(
      `${ui.paint("dim", "hint:")} /pp-* commands come from the pi extension, not from the cli — ` +
        `upgrade it, then /reload inside pi`,
    );
  }
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

/**
 * The watch loop: the same table as `pp status`, plus a record of what changed.
 * Redrawing every second only helps someone staring at it; the point of a watch
 * is the *transition* — "web went off at 10:31" is the thing you act on.
 */
async function cmdStatusWatch(config, options, ui) {
  const seconds = options.watch === true ? 10 : Math.max(2, Number(options.watch) || 10);
  const clear = "\u001b[H\u001b[2J";
  const events = [];
  let stopping = false;
  const stop = () => {
    stopping = true;
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  const snapshot = () => {
    const states = new Map();
    const stuck = new Map();
    const unreachable = new Set();
    const byNode = new Map();
    for (const session of config.sessions) {
      const key = session.node ?? "";
      if (!byNode.has(key)) byNode.set(key, []);
      byNode.get(key).push(session);
    }
    for (const [nodeName, list] of byNode) {
      let live = new Map();
      let handle = null;
      try {
        handle = makeTmux(config, options, nodeName ? { node: nodeName } : undefined);
        if (nodeName && !handle.reachable()) unreachable.add(nodeName);
        else live = handle.listSessions();
      } catch {
        if (nodeName) unreachable.add(nodeName);
      }
      for (const session of list) {
        const running = live.has(session.tmuxName);
        states.set(session.name, running ? "running" : "off");
        // only this machine's panes are cheap enough to read every cycle
        if (running && !nodeName && handle) {
          try {
            const reading = stallWatch(config, handle, session);
            if (reading?.busy && reading.quiet > 0) stuck.set(session.name, reading.quiet);
          } catch {
            /* a pane that vanishes between the two calls is not news */
          }
        }
      }
    }
    return { states, stuck, unreachable };
  };

  const clock = () => new Date().toTimeString().slice(0, 8);

  const diff = (before, after) => {
    for (const [name, state] of after.states) {
      const was = before.states.get(name);
      if (was === "running" && state !== "running") events.push(`${clock()}  ${name} went off`);
      if (was && was !== "running" && state === "running") events.push(`${clock()}  ${name} came back`);
    }
    for (const [name, quiet] of after.stuck) {
      if (!before.stuck.has(name)) events.push(`${clock()}  ${name} stuck — quiet ${quiet}m`);
    }
    for (const name of before.stuck.keys()) {
      if (!after.stuck.has(name)) events.push(`${clock()}  ${name} moving again`);
    }
    for (const node of after.unreachable) {
      if (!before.unreachable.has(node)) events.push(`${clock()}  node ${node} unreachable`);
    }
  };

  const render = (now) => {
    const buffer = [];
    const captured = {
      json: false,
      quiet: false,
      paint: ui.paint,
      out: (line = "") => buffer.push(String(line)),
      info: (line = "") => buffer.push(String(line)),
      warn: (line = "") => buffer.push(ui.paint("yellow", `warning: ${line}`)),
      error: (line = "") => buffer.push(ui.paint("red", `error: ${line}`)),
    };
    cmdStatus(config, { ...options, watch: undefined }, captured);
    const head =
      `${ui.paint("bold", "watching")} ` +
      ui.paint("dim", `${config.path} — every ${seconds}s, ctrl-c to stop`) +
      "  " +
      ui.paint("dim", clock());
    const tail = events.slice(-6).map((line) => ui.paint("dim", line));
    return [head, "", ...buffer, "", ...(tail.length ? tail : [ui.paint("dim", "no changes yet")])];
  };

  let previous = snapshot();
  process.stdout.write(`${clear}${render(previous).join("\n")}\n`);
  while (!stopping) {
    await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
    if (stopping) break;
    const now = snapshot();
    diff(previous, now);
    previous = now;
    process.stdout.write(`${clear}${render(now).join("\n")}\n`);
  }
  process.stdout.write("\n");
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
/** `--all` marks a job as "every session that is running right now". */
const ALL_SESSIONS = "*";
// heal: after this many restarts inside the window, stop and let a human look
const HEAL_LIMIT = 3;
const HEAL_WINDOW_MS = 60 * 60 * 1000;

/**
 * Fan a prompt out to every running session. Busy agents are skipped — pi parks
 * typed input in its editor and never submits it, so a busy pane would only
 * collect another copy (see `deliverJob`).
 */
function deliverToEverySession(tmux, job) {
  let live;
  try {
    live = tmux.listSessions();
  } catch {
    live = new Map();
  }
  const names = [...live.keys()].sort();
  if (names.length === 0) return { status: "skipped: no tmux session is running" };
  const sent = [];
  const busy = [];
  const failed = [];
  for (const name of names) {
    if (tmux.isAgentBusy(name)) {
      busy.push(name);
      continue;
    }
    let result;
    try {
      result = tmux.sendText(name, job.prompt);
    } catch {
      failed.push(name);
      continue;
    }
    if (result.submitted) sent.push(name);
    else failed.push(name);
  }
  if (sent.length === 0 && failed.length === 0) {
    return { status: `deferred: all ${busy.length} sessions are working — the next tick will deliver` };
  }
  if (sent.length === 0) {
    return { status: `failed: none of ${names.length} sessions took the prompt (${failed.join(", ")})` };
  }
  const detail = [`${sent.length}/${names.length}`];
  if (busy.length) detail.push(`${busy.length} busy`);
  if (failed.length) detail.push(`${failed.length} failed (${failed.join(", ")})`);
  return { status: "delivered", text: `to ${detail.join(", ")}` };
}

/**
 * `pp cron add --heal` — put the config back where it belongs, unattended.
 *
 * A session that dies at 3am (OOM, a crashed agent, a closed laptop) is the
 * one failure nobody notices until morning. Restarting it is safe by
 * construction: `up --drift` only starts what is missing and it respects a
 * session somebody stopped on purpose, so this can run every few minutes.
 */
/**
 * Runtime health, as a short list of sentences a human (or an agent) can act on.
 * Deliberately not the whole of `pp doctor`: autostart units and extension
 * versions do not change at 3am, sessions dying and agents hanging do.
 */
export function fleetProblems(config, options) {
  const problems = [];
  if (!config) return problems;
  const local = config.sessions.filter((session) => !session.node);
  let live = new Map();
  const handle = makeTmux(config, options);
  try {
    live = handle.listSessions();
  } catch {
    return [{ kind: "tmux", text: "tmux is not answering — nothing could be checked" }];
  }
  if (!live.size && local.length) {
    // an empty answer can also mean "there is no server at all", which an empty
    // listing happily disguises as "everything is off"
    const server = (() => {
      try {
        return handle.hasServer();
      } catch {
        return false;
      }
    })();
    if (!server) return [{ kind: "tmux", text: "tmux is not running here — nothing could be checked" }];
  }
  const mine = new Set(local.map((session) => session.tmuxName));
  for (const session of local) {
    if (live.has(session.tmuxName)) continue;
    if (session.restart === "no" || isStopped(config.path, session.name) || drainOf(config, session)) continue;
    problems.push({ kind: "off", name: session.name, text: `off: ${session.name} (pp up ${session.name})` });
  }
  for (const name of live.keys()) {
    if (!mine.has(name)) problems.push({ kind: "unmanaged", name, text: `unmanaged: ${name} (pp adopt ${name})` });
  }
  const limit = stallMinutes(options?.env ?? process.env);
  const tmux = handle;
  for (const session of local) {
    if (!live.has(session.tmuxName)) continue;
    // the sweep is often the only thing running an hourly look: it also refreshes
    // the activity clock, so a long build is visible as "quiet 0m" not "busy 3h"
    const watch = stallWatch(config, tmux, session);
    if (!watch || !watch.busy) continue;
    if (watch.quiet >= limit) {
      problems.push({
        kind: "stuck",
        name: session.name,
        text: `stuck: ${session.name} no new output for ${watch.quiet}m (pp logs ${session.name})`,
      });
    }
  }
  return problems;
}

/** One line, short enough that a 1000-character paste marker never kicks in. */
export function formatSweepLine(problems, { id = null, most = 4 } = {}) {
  const head = `fleet health${id ? ` (pp cron ${id})` : ""}: ${problems.length} problem${problems.length === 1 ? "" : "s"}`;
  const shown = problems.slice(0, most).map((problem) => problem.text);
  const rest = problems.length - shown.length;
  return `${head} — ${shown.join("; ")}${rest > 0 ? `; and ${rest} more (pp status)` : ""}`;
}

/**
 * `pp cron add --sweep --to <session>`: the fleet reports itself, but only when
 * something is wrong. Silence is the healthy state; that is the whole point.
 */
function sweepFleet(job, options) {
  let config = null;
  try {
    config = loadConfig({ configPath: job.configPath ?? undefined, cwd: process.cwd() });
  } catch (error) {
    return { status: `failed: ${error.message}` };
  }
  if (!config) return { status: "failed: no config to sweep" };
  const problems = fleetProblems(config, options);
  if (!problems.length) return { status: "delivered", text: "all quiet" };
  const tmux = makeTmux(config, options);
  if (tmux.isAgentBusy(job.session)) {
    return { status: `deferred: ${job.session} is working — the next tick will deliver` };
  }
  const line = formatSweepLine(problems, { id: job.id });
  const sent = tmux.sendText(job.session, line);
  if (!sent.submitted) {
    return { status: `failed: typed into ${job.session} but Enter never took it`, screen: sent.screen };
  }
  return { status: "delivered", text: `${problems.length} problem${problems.length === 1 ? "" : "s"} → ${job.session}` };
}

function healDrift(job, options) {
  let config = null;
  try {
    config = loadConfig({ configPath: job.configPath ?? undefined, cwd: process.cwd() });
  } catch (error) {
    return { status: `failed: ${error.message}` };
  }
  if (!config) return { status: "failed: no config to heal from" };
  const liveCache = new Map();
  const liveFor = (session) => {
    const key = session.node ?? "";
    if (!liveCache.has(key)) {
      try {
        liveCache.set(key, makeTmux(config, options, session).listSessions());
      } catch {
        liveCache.set(key, new Map());
      }
    }
    return liveCache.get(key);
  };
  const missing = config.sessions.filter(
    (session) =>
      !liveFor(session).has(session.tmuxName) &&
      !isStopped(config.path, session.name) &&
      !drainOf(config, session),
  );
  if (!missing.length) return { status: "delivered", text: "nothing needed starting" };

  // A session that dies immediately (bad cwd, missing binary) would be started
  // every tick forever. Three attempts in an hour is enough to call it broken
  // and let a human look, instead of burning the machine in a quiet loop.
  const recent = new Map();
  try {
    const since = new Date(Date.now() - HEAL_WINDOW_MS);
    for (const entry of readAudit({ action: "heal", since, limit: 0 }, process.env)) {
      recent.set(entry.target, (recent.get(entry.target) ?? 0) + 1);
    }
  } catch {
    // no audit trail is not a reason to stop healing
  }
  const thrashing = options.force
    ? []
    : missing.filter((session) => (recent.get(session.name) ?? 0) >= HEAL_LIMIT);
  const attempted = missing.filter((session) => !thrashing.includes(session));
  if (!attempted.length) {
    return {
      status: `deferred: ${thrashing.map((s) => s.name).join(", ")} keep dying (${HEAL_LIMIT} restarts in an hour) — someone should look`,
    };
  }
  const started = [];
  const failed = [];
  for (const session of attempted) {
    if (session.restart === "no") continue;
    try {
      const tmux = makeTmux(config, options, session);
      const spec = prepareSession(session, options);
      tmux.create(session, launchSpec(session, tmux, spec));
      markStarted(config.path, session.name, { why: "heal", by: auditActor(process.env) });
      markRestart(config.path, session.name, { why: "heal", by: auditActor(process.env) });
      started.push(session.name);
      note("heal", session.name, { node: session.node ?? null, detail: "restarted by cron --heal", result: "ok" });
    } catch (error) {
      failed.push(`${session.name} (${error.message.split("\n")[0]})`);
    }
  }
  if (!started.length && failed.length) return { status: `failed: could not start ${failed.join(", ")}` };
  const detail = started.length ? `started ${started.join(", ")}` : "nothing needed starting";
  const skippedNote = thrashing.length ? `, skipped ${thrashing.map((s) => s.name).join(", ")} (keeps dying)` : "";
  const tail = failed.length ? `${detail}, failed ${failed.join(", ")}` : detail;
  return { status: "delivered", text: `${tail}${skippedNote}` };
}

function deliverJob(job, options) {
  if (job.action === "heal") return healDrift(job, options);
  if (job.action === "sweep") return sweepFleet(job, options);
  if (job.action === "command") {
    const result = spawnSync("sh", ["-c", job.command], { encoding: "utf8" });
    if (result.error) return { status: `failed: ${result.error.message}` };
    if (result.status !== 0) return { status: `failed: exit ${result.status}` };
    return { status: "delivered" };
  }

  const tmux = new Tmux({ socket: job.socket ?? null });
  if (job.session === ALL_SESSIONS) return deliverToEverySession(tmux, job);
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
  // pi holds input in the editor while a turn is running and does not submit it,
  // so typing now would only pile another copy into the box. Let the next tick
  // deliver it instead; the prompt is not lost, the schedule simply waits.
  if (tmux.isAgentBusy(job.session)) {
    return { status: `deferred: ${job.session} is working — the next tick will deliver` };
  }
  let result;
  try {
    result = tmux.sendText(job.session, job.prompt);
  } catch (error) {
    return { status: `failed: tmux send-keys: ${error.message}` };
  }
  if (!result.submitted) {
    // Quote what the pane showed: "Enter never took" alone does not say why.
    const tail = String(result.screen ?? "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(-2)
      .join(" / ")
      .slice(0, 160);
    const why = result.reused ? "the prompt is in the box but Enter never took it" : "typed into the box but Enter never took it";
    return { status: `failed: ${job.session} — ${why}${tail ? ` — pane showed: ${tail}` : ""}` };
  }
  return { status: "delivered" };
}

/**
 * Wait until a session's agent will accept a prompt.
 *
 * `pp up` returns as soon as tmux has created the session, which is seconds
 * before pi has drawn its input box. Scripts and `pp up --wait` need the later
 * moment: "ready" means the editor region exists and no spinner is turning.
 */
export async function waitReady(tmux, session, { timeoutMs = 60000, intervalMs = 500, env = process.env } = {}) {
  const started = Date.now();
  // an explicit timeout wins over the environment; the env var is for scripts
  const fromEnv = Number(env.PP_READY_SECONDS ?? 0);
  const limit = timeoutMs > 0 ? timeoutMs : fromEnv > 0 ? fromEnv * 1000 : 60000;
  for (;;) {
    if (!tmux.sessionExists(session.tmuxName)) return { ready: false, reason: "it is not running", seconds: 0 };
    const screen = tmux.capture(session.tmuxName, 40);
    if (!looksBusy(screen) && hasEditor(screen)) {
      return { ready: true, seconds: Math.round((Date.now() - started) / 100) / 10 };
    }
    if (Date.now() - started > limit) {
      return {
        ready: false,
        reason: looksBusy(screen) ? "still working" : "no prompt yet",
        seconds: Math.round((Date.now() - started) / 100) / 10,
      };
    }
    await sleep(intervalMs);
  }
}

/** Local wall-clock stamp: `2026-11-21 09:00` (the timezone cron jobs run in). */
/**
 * Jobs whose next run is in the past by more than a minute.
 *
 * A `deferred:` last status is not late — the tick fired and the target was
 * busy, so the same schedule legitimately comes due again next minute. Anything
 * else overdue means either the tick stopped or this one job is stuck.
 */
export function overdueJobs(jobs, now = new Date(), { grace = 60 } = {}) {
  const late = [];
  for (const job of jobs) {
    if (job.done) continue;
    if (String(job.lastStatus ?? "").startsWith("deferred:")) continue;
    const due = nextRun(job, now);
    if (!due) continue;
    const seconds = Math.round((now.getTime() - due.getTime()) / 1000);
    if (seconds <= grace) continue;
    const minutes = Math.round(seconds / 60);
    late.push({ id: job.id, session: job.session ?? null, seconds, late: minutes < 60 ? `${minutes}m` : `${Math.round(minutes / 60)}h` });
  }
  // the oldest one is the one to look at
  return late.sort((a, b) => b.seconds - a.seconds);
}

function localStamp(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * "in 3m (10:40)" instead of a bare timestamp.
 *
 * A bare `10:40` makes you do arithmetic at 3am, and — worse — a job whose next
 * run is *in the past* looks exactly like a healthy one. `late 12m` is the
 * signature of a tick that stopped firing, which no absolute timestamp shows.
 */
export function describeNext(due, now = new Date()) {
  if (!due) return { text: "-", late: false };
  const delta = Math.round((due.getTime() - now.getTime()) / 1000);
  const clock = localStamp(due).slice(11);
  // coarse on purpose: "in 3m" is what you act on, seconds are noise
  const rough = (seconds) => {
    const abs = Math.abs(seconds);
    if (abs < 60) return `${abs}s`;
    if (abs < 3600) return `${Math.round(abs / 60)}m`;
    if (abs < 86400) return `${Math.round(abs / 3600)}h`;
    return `${Math.round(abs / 86400)}d`;
  };
  if (delta < -60) return { text: `late ${rough(delta)} (${clock})`, late: true };
  if (delta < 0) return { text: `due now (${clock})`, late: true };
  return { text: `in ${rough(delta)} (${clock})`, late: false };
}

function cronRow(job, now = new Date()) {
  const due = nextRun(job, now);
  const next = describeNext(due, now);
  return {
    id: job.id,
    session: job.action === "command" ? `$ ${job.command}` : job.session === ALL_SESSIONS ? "all sessions" : job.session,
    action: job.action,
    session: job.session ?? null,
    schedule: describeSchedule(job.schedule),
    next: next.text,
    late: next.late,
    nextRun: due ? due.toISOString() : null,
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
  // a command job has no session at all, so this has to survive null
  const target = (session, action) =>
    action === "sweep"
      ? `fleet → ${session ?? "-"}`
      : action === "heal"
      ? "drift (up --drift)"
      : action === "command"
        ? "$ (localhost)"
        : session === ALL_SESSIONS
          ? "all sessions"
          : session ?? "-";
  const table = records.map((row) => [row.id, target(row.session, row.action), row.schedule, row.next, String(row.runs), row.last]);
  const widths = headers.map((h, i) => Math.max(h.length, ...table.map((row) => row[i].length)));
  const pad = (value, width) => value + " ".repeat(Math.max(0, width - value.length));
  ui.out(ui.paint("bold", headers.map((h, i) => pad(h, widths[i])).join("  ").trimEnd()));
  table.forEach((row) => {
    const colored = [...row];
    colored[0] = ui.paint("dim", colored[0]);
    colored[3] = records[table.indexOf(row)].late ? ui.paint("yellow", colored[3]) : ui.paint("cyan", colored[3]);
    ui.out(colored.map((cell, index) => pad(cell, widths[index])).join("  ").trimEnd());
  });
  const late = records.filter((row) => row.late).length;
  if (late) {
    ui.out(
      ui.paint("yellow", `${late} job${late === 1 ? "" : "s"} past due — `) +
        ui.paint("dim", "the tick may not be firing: pp install (or: pp cron tick)"),
    );
  }
}

async function cmdCronAdd(config, options, ui) {
  const text = options.names.join(" ").trim();
  const command = options.command;
  const healing = Boolean(options.heal);
  const sweeping = Boolean(options.sweep);
  if (healing && sweeping) throw new CronError("--heal and --sweep are different jobs — add them one at a time");
  if (healing) {
    if (options.session || options.all) throw new CronError("--heal needs no session — it starts whatever is missing");
    if (command) throw new CronError("--heal takes no command — it runs: pp up --drift");
    if (text) throw new CronError("--heal takes no prompt — it runs: pp up --drift");
  } else if (sweeping) {
    if (options.all) throw new CronError("--sweep reports into one session — pass --to <session>");
    if (command) throw new CronError("--sweep takes no command — it checks the fleet and reports");
    if (text) throw new CronError("--sweep takes no prompt — it writes its own report");
    if (options.session) throw new CronError("--sweep reports into one session — use --to <session>, not --session");
    if (!options.to) throw new CronError("--sweep needs a destination: --to <session> (where the report is typed)");
  } else {
    if (!text && !command) throw new CronError('nothing to say at that time — pass the prompt: pp cron add --at ... "check the build"');
    if (text && command) throw new CronError("give either a prompt or --command, not both");
  }

  const schedule = buildSchedule({ at: options.in ? new Date(Date.now() + parseDuration(options.in, { what: "--in" }) * 1000).toISOString() : options.at, every: options.every, cron: options.cronExpr });

  let session = null;
  let socket = options.socket ?? config?.tmuxSocket ?? null;
  let configPath = config?.path ?? null;
  if (healing) {
    session = null;
  } else if (sweeping) {
    const wanted = options.to;
    const resolved = config ? resolveSessionRef(config, wanted) : null;
    if (resolved) {
      session = resolved.tmuxName;
    } else {
      let live = new Map();
      try {
        live = makeTmux(config, options).listSessions();
      } catch {
        live = new Map();
      }
      if (!live.has(wanted)) {
        throw new CronError(`unknown destination "${wanted}" — not in ${config?.path ?? "the config"} and not running in tmux`);
      }
      session = wanted;
    }
  } else if (options.all) {
    if (options.session) throw new CronError("give either --session <name|#> or --all, not both");
    if (command) throw new CronError("--all takes a prompt — a command runs once, not per session");
    session = ALL_SESSIONS;
  } else if (!command) {
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
    action: healing ? "heal" : sweeping ? "sweep" : command ? "command" : "prompt",
    ...(healing ? {} : sweeping ? { session, socket } : command ? { command } : { prompt: text, session, socket }),
    schedule,
    catchUp: options.catchUp ? parseDuration(options.catchUp, { what: "--catch-up" }) : DEFAULT_CATCH_UP_SECONDS,
    startSession: Boolean(options.start),
    configPath,
    createdAt: new Date().toISOString(),
    runs: 0,
  };

  const due = nextRun(job);
  if (options.dryRun) {
    ui.out(`[dry-run] would schedule ${job.id}: ${describeSchedule(schedule)} → ${job.action === "heal" ? "heal (up --drift)" : job.action === "command" ? `$ ${command}` : `session ${session}`}`);
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
  note("cron.add", job.id, {
    detail: `${describeSchedule(schedule)} → ${job.action === "command" ? `$ ${command}` : session}`,
    result: "ok",
  });
  ui.info(`${ui.paint("green", "scheduled")} ${job.id}  ${describeSchedule(schedule)}  →  ${job.action === "heal" ? "heal (up --drift)" : job.action === "command" ? `$ ${command}` : `session ${session}`}`);
  ui.info(ui.paint("dim", `first run: ${due ? due.toLocaleString() : "never"}   cancel with: pp cron rm ${job.id}`));
  if (!options.start && job.action === "prompt" && session !== ALL_SESSIONS) {
    ui.info(ui.paint("dim", `the session must be running at that moment (add --start to bring it up first)`));
  }
  if (session === ALL_SESSIONS) {
    ui.info(ui.paint("dim", `every session running at that moment gets it; a busy agent is skipped and retried on the next tick`));
  }
  refreshCronLog(options, ui);
}

/**
 * `pp audit` — what changed on this machine, newest last.
 *
 * The first question after an incident is "did anyone touch it?", and the first
 * answer anyone believes is one they can read without a database.
 */
function cmdAudit(config, options, ui) {
  const file = options.file ? resolve(expandPath(options.file)) : auditPath();
  if (options.prune) {
    let seconds;
    try {
      seconds = parseDuration(options.prune, { what: "--prune" });
    } catch (err) {
      ui.error(err.message);
      process.exit(2);
    }
    const cutoff = new Date(Date.now() - seconds * 1000);
    const { kept, dropped } = pruneAudit({ olderThan: cutoff, file });
    if (ui.json) ui.out(JSON.stringify({ kept, dropped, cutoff: cutoff.toISOString() }, null, 2));
    else ui.info(`pruned ${dropped} entr${dropped === 1 ? "y" : "ies"} older than ${formatDuration(seconds)} (kept ${kept})`);
    return;
  }

  let since = null;
  if (options.since) {
    let seconds;
    try {
      seconds = parseDuration(options.since, { what: "--since" });
    } catch (err) {
      ui.error(err.message);
      process.exit(2);
    }
    since = new Date(Date.now() - seconds * 1000);
  }
  const target = options.names[0] ?? null;
  const entries = readAudit({ limit: options.lines ?? 30, action: options.action ?? null, actor: options.actor ?? null, target, since, file });

  if (ui.json) {
    ui.out(JSON.stringify(entries, null, 2));
    return;
  }
  if (!entries.length) {
    ui.info(ui.paint("dim", `nothing recorded${target ? ` for ${target}` : ""}${options.action ? ` (action ${options.action})` : ""} — the trail starts with the next change`));
    ui.info(ui.paint("dim", `file: ${file}`));
    return;
  }
  ui.info(ui.paint("dim", `${file}  (${entries.length} entr${entries.length === 1 ? "y" : "ies"})`));
  const now = new Date();
  for (const entry of entries) {
    const cold = /^(rm|down|node\.rm)$/.test(entry.action);
    const bits = [agoText(entry.ts, now).padEnd(8), ui.paint(cold ? "red" : "cyan", String(entry.action ?? "?").padEnd(12)), entry.target ?? "-"];
    if (entry.node) bits.push(ui.paint("dim", `on ${entry.node}`));
    if (entry.detail) bits.push(`— ${entry.detail}`);
    if (entry.result) bits.push(ui.paint("dim", `(${entry.result})`));
    ui.out(bits.join(" "));
  }
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
    note("cron.rm", id, { detail: describeSchedule(job.schedule), result: "ok" });
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
    // "delivered" on its own hides the interesting part: how many, and what
    // was refused. The tick writes the same text to cron.log.
    const detail = result.text ? ` ${ui.paint("dim", `— ${result.text}`)}` : "";
    ui.info(`${ui.paint(paint, result.status)} ${id}${detail}`);
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
    case "adopt": {
      const config = requireConfig(options, ui);
      return cmdAdopt(config, options, ui);
    }
    case "mv":
    case "move": {
      const config = requireConfig(options, ui);
      return cmdMv(config, options, ui);
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
    case "node":
    case "nodes": {
      const sub = String(options.names[0] ?? "ls").toLowerCase();
      const readOnly = ["ls", "list", "status", "show", "info", "describe", "test", "ping", "probe", "check"].includes(sub);
      let config = null;
      try {
        config = loadConfig({ configPath: options.config, cwd: options.cwd });
      } catch (err) {
        if (options.config || !readOnly) {
          ui.error(err.message);
          process.exit(2);
        }
        ui.warn(err.message);
        config = null;
      }
      return cmdNode(config, options, ui);
    }
    case "audit": {
      const config = tryLoadConfig(options);
      return cmdAudit(config, options, ui);
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
    case "clean": {
      const config = requireConfig(options, ui);
      return cmdClean(config, options, ui);
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
