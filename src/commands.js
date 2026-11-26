import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, statSync, statfsSync, writeFileSync } from "node:fs";
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
  renameSessionInFile,
} from "./config.js";
import { agoText, auditActor, readAudit, recordAudit, stateDir } from "./audit.js";
import { BACKUP_KEEP, backupDir, backupPlan, describeBackup, listBackups, pruneBackups, restorePlan, verifyBackup, writeBackup } from "./backup.js";
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
import { contentSignature, hasEditor, isRule, lastActionLine, looksBusy, parseSessionLines, resolveExecutable, SESSION_QUERY, Tmux } from "./tmux.js";
import { authSummary, nodeTarget, normalizeNode, NodeError, parseProbe, parseSshConfig, PROBE_SCRIPT, removeNodeFromFile, renderNodeBlock, runOnNode, runOnNodeAsync, sshInvocation, tightenConfigMode, upsertNodeInFile } from "./nodes.js";
import { installAutostart, uninstallAutostart, autostartState, describeAutostart, isWsl, launchAgentPath, systemdUserDir } from "./autostart.js";
import { describeStateFiles, inspectStateFiles, quarantineStateFile } from "./selfcheck.js";
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
  buildSchedule,
  describeSchedule,
  DEFAULT_CATCH_UP_SECONDS,
  cronMatches,
  CronError,
  cronLogPath,
  dailyRuns,
  formatDuration,
  jobsPath,
  newJobId,
  nextRun,
  parseCron,
  parseDuration,
  parseWindow,
  describeWindow,
  inQuietHours,
  readJobs,
  recordRun,
  removeJob,
  resetJob,
  setJobPaused,
  setJobTarget,
  tick as cronTick,
  updateJob,
  writeJobs,
} from "./cron.js";
import { blockStatus as crondBlockStatus, tickHealth as crondTickHealth, hasBlock as crondHasBlock, installBlock as installCrondBlock, readCrontab, renderBlock as renderCrondBlock, uninstallBlock as uninstallCrondBlock } from "./crond.js";
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
import {
  computeLayout,
  createTui,
  displayWidth,
  machineSummary,
  parseLeftOption,
  renderFrame,
  stripAnsi,
  truncateWidth,
} from "./tui.js";
import { ageOf, listPiSessions } from "./pi-sessions.js";

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

/**
 * A session that is running on a machine but not in the config. `pp ls` lists
 * those rows, so `pp attach <that row>` has to work: without this the list
 * would advertise things you cannot touch. Read-only by nature -- `up` finds it
 * running and says so, and `pp adopt --node <machine>` writes it down for real.
 */
function liveStraySession(config, options, name) {
  // `pp sync` already asked every machine; asking again here is what made
  // `pp attach 10` take seconds. Cache first, this machine second.
  const pulled = readNodeCache();
  for (const node of config.nodes ?? []) {
    const cached = pulled[node.name];
    if (!cached || cached.tmux === false) continue;
    const entry = fromCache(cached.sessions).get(name);
    if (entry) {
      return {
        name,
        tmuxName: name,
        cwd: entry.panes?.[0]?.path ?? "/",
        agent: ["pi"],
        pi: true,
        restart: "no",
        node: node.name,
        stray: true,
      };
    }
  }
  const machines = [{ name: null }];
  for (const node of machines) {
    try {
      const handle = makeTmux(config, options ?? {}, { node: node.name });
      const entry = handle.listSessions().get(name);
      if (!entry) continue;
      return {
        name,
        tmuxName: name,
        cwd: entry.panes?.[0]?.path ?? "/",
        agent: ["pi"],
        pi: true,
        piSession: null,
        piSessionDir: null,
        piSessionName: name,
        remotePiName: name,
        remotePiMode: "env",
        env: {},
        args: [],
        log: null,
        remainOnExit: false,
        restart: "no",
        node: node.name,
        stray: true,
      };
    } catch {
      // an unreachable machine cannot host the session we are looking for
    }
  }
  return null;
}

/**
 * Resolve `pp attach 7` against the list `pp ls` prints: configured sessions
 * plus the unmanaged ones running on configured nodes, in the same order. A
 * number that means one thing in the table and another to the command is worse
 * than no numbers at all.
 */
function numberFromTable(config, options, ref) {
  if (!/^\d+$/.test(String(ref))) return null;
  const index = Number(ref);
  const entries = config.sessions.map((session) => ({ name: session.name, session }));
  // The number is a row number of the table `pp ls` printed, and that table is
  // built from the sync cache. Asking the machines again here would give the
  // same answer (or a different one on a bad day) and cost seconds.
  const cache = readNodeCache();
  for (const node of config.nodes ?? []) {
    const cached = cache[node.name];
    if (!cached || cached.tmux === false) continue;
    for (const name of fromCache(cached.sessions).keys()) {
      if (entries.some((entry) => entry.name === name && entry.session?.node === node.name)) continue;
      entries.push({ name, stray: { name, node: node.name } });
    }
  }
  const sortKey = options?.sort ?? config.sort ?? "config";
  if (sortKey === "name") entries.sort((a, b) => compareNames(a.name, b.name));
  const picked = entries[index - 1];
  if (!picked) return null;
  return picked.session ?? liveStraySession(config, options, picked.stray.name);
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
  const onlyRole = options?.role;
  const onNode = (list) => {
    let scoped = allowed === null ? list : list.filter((s) => s.node && allowed.has(s.node));
    if (onlyRole) {
      // roles are free labels, so match case-insensitively: --role PM finds "pm"
      const wanted = String(onlyRole).toLowerCase();
      scoped = scoped.filter((s) => String(s.role ?? "").toLowerCase() === wanted);
    }
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
    if (all) {
      const picked = onNode(config.sessions);
      if (onlyRole && picked.length === 0) {
        const known = [...new Set(config.sessions.map((s) => s.role).filter(Boolean))];
        ui.error(
          `no session has role "${onlyRole}"` + (known.length ? ` (roles in use: ${known.join(", ")})` : " (no roles set yet — pp role <name> <role>)"),
        );
        process.exit(2);
      }
      return picked;
    }
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
    const session =
      (config.nodes?.length ? numberFromTable(config, options, name) : null) ??
      resolveSessionRef(config, name) ??
      liveStraySession(config, options, name);
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
// exported for the test that proves a bad edit is rolled back
export function auditedWrite({ config, action, target, node = null, dryRun = false }, write) {
  const before = dryRun ? null : readConfigText(config?.path);
  const result = write();
  if (dryRun || before === null) return result;
  // every writer goes through here, so the check goes here too: the file we just
  // produced has to be one pp can read back, or the next command fails on the
  // operator's machine with a parse error and no idea which edit caused it
  try {
    loadConfig({ configPath: config.path, cwd: process.cwd() });
  } catch (error) {
    writeFileSync(config.path, before);
    const failure = new Error(`the edit produced a config pp cannot read — put the previous one back (${firstLine(error.message, 140)})`);
    failure.rolledBack = true;
    throw failure;
  }
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

function adHocSession({
  name,
  cwd,
  agent,
  log,
  remotePiName,
  remotePiMode,
  node = null,
  role = null,
  env = {},
  args = [],
  restart = "always",
}) {
  const argv = splitCommand(agent);
  const pi = basename(argv[0] ?? "") === "pi";
  return {
    name,
    tmuxName: name,
    cwd,
    agent: argv,
    role,
    env,
    args,
    pi,
    piSession: null,
    piSessionDir: null,
    piSessionName: pi ? name : null,
    remotePiName,
    remotePiMode,
    log,
    remainOnExit: false,
    restart,
    node,
  };
}

async function cmdNew(baseConfig, options, ui) {
  // `--from`: clone the shape of a session that already works (node, cwd, role,
  // agent, env, args, restart policy) and only change what you name.
  let source = null;
  if (options.from) {
    const sessions = baseConfig?.sessions ?? [];
    const ref = String(options.from);
    source =
      sessions.find((session) => session.name === ref || session.tmuxName === ref) ??
      (/^\d+$/.test(ref) ? sessions[Number(ref) - 1] : null) ??
      null;
    if (!source) {
      ui.error(`no session "${ref}" to copy — see pp status${baseConfig?.path ? "" : " (no config found)"}`);
      process.exit(2);
    }
  }

  // `--node` puts the session on another machine: the directory only has to
  // exist *there*, so leave the check to the remote tmux.
  let node = null;
  if (options.node) {
    node = (baseConfig?.nodes ?? []).find((entry) => entry.name === options.node);
    if (!node) {
      ui.error(`no node "${options.node}" — see pp node ls`);
      process.exit(2);
    }
  } else if (source?.node) {
    node = (baseConfig?.nodes ?? []).find((entry) => entry.name === source.node) ?? null;
  }
  let cwd = resolve(expandPath(options.dir ?? source?.cwd ?? process.cwd()));
  if (node?.basePath && options.dir && !/^[~/]/.test(options.dir) && !/^\.\.?\//.test(options.dir)) {
    // "-C api" on a machine whose sessions live in /srv means /srv/api
    cwd = `${String(node.basePath).replace(/\/+$/, "")}/${options.dir.replace(/^\.\//, "")}`;
  }
  if (!node && (!existsSync(cwd) || !statSync(cwd).isDirectory())) {
    ui.error(`directory does not exist: ${cwd}`);
    process.exit(2);
  }

  // a name typed on the command line is explicit (clash = error); a name we
  // derived (from the directory or from --from) may quietly become "x-2"
  const explicitName = options.from ? null : options.names[0];
  let name = tmuxSafeName(options.names[0] ?? source?.name ?? basename(cwd));
  if (!SAFE_TMUX_NAME.test(name)) {
    ui.error(`invalid session name "${name}": use letters, digits, "-" and "_"`);
    process.exit(2);
  }

  const tmux = makeTmux(baseConfig ?? { tmuxSocket: null, nodes: [] }, options, { node: node?.name ?? null });
  const live = tmux.listSessions();
  // "taken" means taken in tmux *or* already written down in the config: with
  // --from the name comes from the source session, so the config is the first
  // place a clash shows up
  const written = new Set((baseConfig?.sessions ?? []).map((session) => session.name));
  const taken = (candidate) => live.has(candidate) || written.has(candidate);
  if (taken(name)) {
    if (explicitName && !options.force) {
      ui.error(`session "${name}" already exists (--force to recreate, or pick another name)`);
      process.exit(2);
    }
    if (!options.force) {
      let suffix = 2;
      while (taken(`${name}-${suffix}`)) suffix += 1;
      ui.info(ui.paint("dim", `${name} is taken, using ${name}-${suffix}`));
      name = `${name}-${suffix}`;
    }
  }

  const agent = options.agent ?? (source ? source.agent.join(" ") : "pi");
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
    role: options.role ?? source?.role ?? null,
    env: source?.env ?? {},
    args: source?.args ?? [],
    restart: source?.restart ?? "always",
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

  if (options.save && options.dryRun) {
    ui.info(ui.paint("dim", `[dry-run] would append ${session.name} to ${config.path}`));
  } else if (options.save) {
    saveNewSession(config.path, session, ui);
  }
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
  // the same renderer `pp adopt` uses, plus the two remote-pi lines an ad-hoc
  // session always needs (its name is per-session, so it goes in the env)
  const entry = [
    // an ad-hoc session restarts "always" (adHocSession says so); the renderer
    // defaults to unless-stopped, so state it explicitly rather than let
    // `pp new --save` silently change the policy
    renderSessionEntry({ ...session, restart: session.restart ?? "always" }),
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

/**
 * Which open todos point at a session that is no longer running.
 *
 * `pp todo ls` marks them `(offline)`; after a few days of work they are the
 * bulk of the list, and deleting them by hand one # at a time is the wrong
 * amount of work. Pure, so the rule can be tested without tmux.
 */
export function offlineTodos(todos, exists) {
  const open = todos.filter((todo) => todo.state !== "done");
  const seen = new Map();
  for (const todo of open) {
    if (!seen.has(todo.session)) seen.set(todo.session, Boolean(exists(todo.session)));
  }
  return open.filter((todo) => seen.get(todo.session) === false);
}

async function clearOfflineTodos(config, options, ui) {
  let todos = readTodos();
  const owners = new Map();
  const exists = (name) => {
    if (!owners.has(name)) {
      const owner = (config?.sessions ?? []).find((item) => item.tmuxName === name || item.name === name) ?? null;
      owners.set(name, makeTmux(config, options, owner));
    }
    return owners.get(name).sessionExists(name);
  };
  const gone = offlineTodos(todos, exists);
  if (gone.length === 0) {
    ui.info("nothing to clear — every open todo points at a session that is running");
    return;
  }
  if (options.dryRun) {
    for (const todo of gone) ui.info(`[dry-run] would drop #${todo.id} ${todo.session} — ${todo.title.slice(0, 60)}`);
    return;
  }
  for (const todo of gone) todos = removeTodo(todos, todo);
  ui.info(`cleared ${gone.length} todo(s) whose session is gone`);
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
      case "answer":
      case "reply": {
        const refs = todoRefs(rest.slice(0, 1), ui, "usage: pp todo answer <#> \"text\"");
        const text = rest.slice(1).join(" ");
        if (!text.trim()) {
          ui.error('usage: pp todo answer <#> "text"');
          process.exit(2);
        }
        // The todo exists because an agent is blocked on a human; answering it is
        // the whole point of the queue, so it should not need a second command.
        const todos = readTodos();
        const todo = resolveTodo(todos, refs[0]).todo;
        const owner = (config?.sessions ?? []).find((item) => item.tmuxName === todo.session || item.name === todo.session) ?? null;
        const tmux = makeTmux(config, options, owner);
        if (!tmux.sessionExists(todo.session)) {
          ui.error(`${todo.session} is not running — the answer would go nowhere: pp up ${owner?.name ?? todo.session}`);
          process.exit(1);
        }
        if (options.dryRun) {
          ui.info(`[dry-run] tmux send-keys -t =${todo.session}: -l -- ${text}; Enter; mark #${todo.id} done`);
          return;
        }
        if (tmux.isAgentBusy(todo.session)) {
          ui.warn(`${todo.session} is mid-turn — it is not waiting for this answer; try again when it is idle`);
          process.exitCode = 1;
          return;
        }
        const sent = tmux.sendText(todo.session, text, { enter: !options.noEnter });
        if (!sent.submitted && !options.noEnter) {
          ui.error(`typed the answer into ${todo.session} but Enter never took it — read it with: pp logs ${todo.session}`);
          process.exitCode = 1;
          return;
        }
        setTodoState(todos, todo, "done");
        note("todo.answer", todo.session, { detail: `#${todo.id} ${text.slice(0, 80)}` });
        ui.info(`answered #${todo.id} in ${todo.session}${options.noEnter ? " (Enter not pressed)" : ""}`);
        return;
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
        if (options.offline) return clearOfflineTodos(config, options, ui);
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
        ui.info("usage: pp todo [ls | add | answer | done | seen | attach | rm | clear]");
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
    if (removed) ui.info(ui.paint("dim", `the config was edited; pp backup is the cheap insurance before the next change`));
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
  // `pp node show 1` should work like `pp node 1`: every command that takes a
  // machine accepts its number, not just its name.
  const node = resolveNodeRef(config, name) ?? findNode(config, name);
  if (!node) {
    const known = (config?.nodes ?? []).map((n) => n.name);
    ui.error(`no node "${name}"${known.length ? ` (known: ${known.join(", ")})` : " — add one: pp node add " + name + " --host <ip>"}`);
    process.exit(2);
  }
  return node;
}

/** The groups in use, for "no node matches that" to be useful. */
function groupsInUse(config) {
  const seen = new Set();
  for (const node of config?.nodes ?? []) if (node.group) seen.add(node.group);
  return [...seen].sort().join(", ");
}

async function printNodes(config, options, ui) {
  const filtered = Boolean(options.node) || Boolean(options.tags?.length) || Boolean(options.group);
  let nodes = filtered ? taggedNodes(config, options) : (config?.nodes ?? []);
  if (options.group) {
    const wanted = String(options.group).toLowerCase();
    nodes = nodes.filter((node) => String(node.group ?? "(none)").toLowerCase() === wanted);
  }
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
          live: liveCounts.has(node.name) ? liveCounts.get(node.name) : null,
          group: node.group ?? null,
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
    ui.info(
      `no node matches ${[
        options.node ? `--node ${options.node}` : "",
        options.group ? `--group ${options.group}` : "",
        options.tags?.length ? `--tag ${options.tags.join(" --tag ")}` : "",
      ]
        .filter(Boolean)
        .join(" ")}  ${ui.paint("dim", `(groups in use: ${groupsInUse(config) || "none"})`)}`,
    );
    return;
  }
  if (!nodes.length) {
    ui.info("no nodes yet. A session can run on another machine once you register it:");
    ui.info("  pp node add prod-01 --host 10.0.0.11 --user deploy --identity ~/.ssh/id_ed25519");
    ui.info("  pp node test prod-01");
    return;
  }
  const showGroup = nodes.some((node) => node.group);
  // what is actually running there, not only what is written down: "SESSIONS 0"
  // for a machine with nine live sessions is a lie of omission
  const liveCounts = new Map();
  if (config?.nodes?.length) {
    const cache = readNodeCache();
    const ttlMs = NODE_TTL_SECONDS * 1000;
    await Promise.all(
      config.nodes.map(async (node) => {
        const cached = cache[node.name];
        // A table of counts is not worth an ssh round trip per machine:
        // `pp sync` keeps it fresh, and `--fresh` is how you insist.
        if (cached && !options.fresh) {
          const stale = Date.now() - Number(cached.at ?? 0) >= ttlMs;
          const value = cached.tmux === false ? "no tmux" : fromCache(cached.sessions).size;
          liveCounts.set(node.name, stale ? `${value}?` : value);
          return;
        }
        // Not in the cache and no --fresh: say "unknown" instead of opening an
        // ssh connection. `pp node ls` answering in 4s because six machines each
        // took a timeout is exactly the complaint this avoids.
        if (!options.fresh) {
          liveCounts.set(node.name, cached ? "?" : "-");
          return;
        }
        const found = await makeTmux(config, options, { node: node.name })
          .listSessionsStrict()
          .catch(() => null);
        if (found) {
          cache[node.name] = { at: Date.now(), tmux: true, sessions: asCache(found) };
          liveCounts.set(node.name, found.size);
        } else {
          liveCounts.set(node.name, cached ? (cached.tmux === false ? "no tmux" : fromCache(cached.sessions).size) : null);
        }
      }),
    );
    writeNodeCache(cache);
  }
  const headers = ["#", "NODE", ...(showGroup ? ["GROUP"] : []), "TARGET", "PORT", "AUTH", "LIVE", "CONFIG", "NOTE"];
  const at = (name) => headers.indexOf(name);
  const table = nodes.map((node, i) => [
    String(i + 1),
    `${node.guarded ? "!" : ""}${node.drained ? "~" : ""}${node.name}`,
    ...(showGroup ? [node.group || "-"] : []),
    nodeTarget(node),
    String(node.port),
    authSummary(node),
    liveCounts.has(node.name) ? (liveCounts.get(node.name) === null ? "?" : String(liveCounts.get(node.name))) : "-",
    String(counts.get(node.name) ?? 0),
    node.note || "",
  ]);
  const widths = headers.map((h, i) => Math.max(h.length, ...table.map((row) => row[i].length)));
  const pad = (value, width) => value + " ".repeat(Math.max(0, width - value.length));
  ui.out(ui.paint("bold", headers.map((h, i) => pad(h, widths[i])).join("  ").trimEnd()));
  table.forEach((row, i) => {
    const cells = [...row];
    cells[0] = ui.paint("dim", cells[0]);
    cells[1] = ui.paint("cyan", cells[1]);
    if (showGroup) cells[at("GROUP")] = ui.paint("magenta", cells[at("GROUP")]);
    const auth = nodes[i] && authSummary(nodes[i]);
    if (auth.endsWith("✗")) cells[at("AUTH")] = ui.paint("red", cells[at("AUTH")]);
    else if (auth === "agent") cells[at("AUTH")] = ui.paint("dim", cells[at("AUTH")]);
    cells[at("LIVE")] = ui.paint(cells[at("LIVE")] === "0" ? "dim" : "cyan", cells[at("LIVE")]);
    cells[at("CONFIG")] = ui.paint("dim", cells[at("CONFIG")]);
    ui.out(cells.map((cell, idx) => pad(cell, widths[idx])).join("  ").trimEnd());
  });
  if (!options.quiet) {
    if (nodes.some((node) => node.guarded)) {
      ui.out(ui.paint("dim", "\n! = guarded (YAML `guarded: true`): pp down / pp rm skip its sessions unless you pass --force"));
    }
    if (nodes.some((node) => node.drained)) {
      ui.out(ui.paint("dim", "~ = drained (YAML `drained: true`): pp up / pp restart skip its sessions while you patch"));
    }
    ui.out(`\n${nodes.length} node${nodes.length === 1 ? "" : "s"}  ${ui.paint("dim", `config: ${config.path}`)}`);
    const orphan = nodes.length && !counts.size ? "  (no session uses one yet: add `node: <name>` to a session)" : "";
    if (orphan) ui.out(ui.paint("dim", orphan.trim()));
    const never = readNodeCache();
    const unseen = nodes.filter((node) => !never[node.name]).length;
    if (unseen) ui.out(ui.paint("dim", `${unseen} machine(s) never synced — pp sync fills LIVE (or: pp node ls --fresh)`));
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
  if (options.group) spec.group = options.group;
  if (options.guard) spec.guarded = true;
  if (options.noGuard) spec.guarded = false;
  if (options.basePath !== undefined) spec.base_path = options.basePath;
  if (options.defaultAgent || options.defaultRestart || options.defaultRemotePiMode || options.defaultRole) {
    spec.defaults = {};
    if (options.defaultAgent) spec.defaults.agent = options.defaultAgent;
    if (options.defaultRestart) spec.defaults.restart = options.defaultRestart;
    if (options.defaultRemotePiMode) spec.defaults.remote_pi_mode = options.defaultRemotePiMode;
    if (options.defaultRole) spec.defaults.role = options.defaultRole;
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
    const node = resolveNodeRef(config, ref) ?? findNode(config, ref);
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
      ui.error(`${node.name} (${nodeTarget(node)}): ${err.message} — pp node show ${node.name} (host, user, identity)`);
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
      ui.warn(`${node.name} has no tmux, so sessions cannot run there — apt install tmux (on ${node.name})`);
    }
    if (!probe.pi || probe.pi === "-") {
      ui.warn(`${node.name} has no pi on PATH for ${node.user ?? "that user"}, so agent sessions there will not start — npm i -g @earendil-works/pi-coding-agent (on ${node.name})`);
    }
  }
  if (failed) process.exitCode = 1;
}

function sshToNode(node, options, ui) {
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



function cmdNodeSsh(config, options, ui) {
  return sshToNode(nodeOrDie(config, options.names[1], ui), options, ui);
}

/**
 * `pp node 1` and `pp node prod-01` mean "go there", the same way `pp attach 3`
 * means "go to the third session". One argument, one ssh.
 */
export function resolveNodeRef(config, ref) {
  const nodes = config?.nodes ?? [];
  const text = String(ref ?? "").trim();
  if (!text) return null;
  const exact = nodes.find((node) => node.name === text);
  if (exact) return exact;
  if (/^\d+$/.test(text)) {
    const index = Number(text);
    if (index >= 1 && index <= nodes.length) return nodes[index - 1];
  }
  return null;
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
  if (["add", "set", "upsert"].includes(sub)) return cmdNodeAdd(config, options, ui);
  if (["rm", "remove", "delete"].includes(sub)) return cmdNodeRm(config, options, ui);
  if (["test", "ping", "probe", "check"].includes(sub)) return cmdNodeTest(config, options, ui);
  if (["ssh", "shell", "connect"].includes(sub)) return cmdNodeSsh(config, options, ui);
  if (["show", "info", "describe"].includes(sub)) return showNode(config, options, ui);
  // `pp node 1` / `pp node prod-01`: the whole point is to stop typing "ssh"
  const byRef = resolveNodeRef(config, options.names[0]);
  if (byRef) return sshToNode(byRef, options, ui);
  if (config?.nodes?.length && /^\d+$/.test(sub)) {
    ui.error(`no node ${sub} — there ${config.nodes.length === 1 ? "is 1 node" : `are ${config.nodes.length} nodes`}: pp node ls`);
    process.exit(2);
  }
  ui.error(`unknown node "${sub}" — try: pp node ls  (then pp node <1|name> to log in)`);
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

/**
 * Per-machine session lists, kept for a few seconds. Reaching five machines
 * costs whatever the slowest ssh costs; the table is asked for far more often
 * than a machine's session list actually changes.
 */
const NODE_TTL_SECONDS = Number(process.env.PP_NODE_TTL ?? 15);

function nodeCachePath() {
  return join(stateDir(process.env), "node-live.json");
}

function readNodeCache() {
  try {
    const data = JSON.parse(readFileSync(nodeCachePath(), "utf8"));
    return data && typeof data === "object" ? data : {};
  } catch {
    return {};
  }
}

function writeNodeCache(data) {
  try {
    mkdirSync(dirname(nodeCachePath()), { recursive: true });
    writeFileSync(nodeCachePath(), `${JSON.stringify(data)}\n`);
  } catch {
    // a cache that cannot be written is not worth an error message
  }
}

const asCache = (map) => {
  const out = {};
  for (const [name, entry] of map) {
    out[name] = {
      activity: entry.activity ?? 0,
      attached: entry.attached ?? 0,
      panes: (entry.panes ?? []).map((pane) => ({ path: pane.path ?? "", command: pane.command ?? "", dead: Boolean(pane.dead) })),
    };
  }
  return out;
};

const fromCache = (entry) => {
  const map = new Map();
  for (const [name, value] of Object.entries(entry ?? {})) {
    map.set(name, {
      name,
      path: value.panes?.[0]?.path ?? "",
      activity: value.activity ?? 0,
      attached: value.attached ?? 0,
      panes: value.panes ?? [],
    });
  }
  return map;
};

async function cmdStatus(config, options, ui) {
  if (options.watch !== undefined && !options.json) return cmdStatusWatch(config, options, ui);
  // status lists every configured session, whatever its restart policy.
  // `--node work-01` means "what runs on work-01", including the sessions
  // nobody wrote down: an empty config for that machine is not an empty machine
  // One tmux query per machine, not one per session: a node is expensive to
  // reach and every session on it shares the answer.
  // One query per machine, all of them at once. Five machines at 300ms each is
  // 1.5s of wall clock if you take turns, and this table is asked for constantly.
  const liveCache = new Map();
  const clientCache = new Map();
  const unreachable = new Set();
  const nodeCache = readNodeCache();
  const ttlMs = NODE_TTL_SECONDS * 1000;
  // A machine nobody wrote a session for is not worth an ssh on every `pp ls`:
  // six nodes over the open internet is six timeouts. It is asked when asked
  // (`--live`), and its last answer is reused for free while it is still warm.
  const wanted = new Set(nodesToProbe(config));
  const askedNot = [];
  const staleNodes = [];
  const cachedAt = new Map();
  const cachedNodes = new Set();
  await Promise.all(
    [null, ...(config.nodes ?? []).map((node) => node.name)].map(async (nodeName) => {
      const key = nodeName ?? "";
      const handle = makeTmux(config, options, { node: nodeName });
      const cached = nodeName ? nodeCache[nodeName] : null;
      const cacheAgeMs = cached ? Date.now() - Number(cached.at ?? 0) : Infinity;
      const warm = Boolean(cached) && !options.fresh;

      const asked = Boolean(options.live) || Boolean(options.all) || Boolean(options.node);
      // A cache entry is an answer, even a stale one: `pp ls` prints what was
      // true N minutes ago and says so, instead of making the operator wait on
      // an ssh that may never come back. `--live` / `--fresh` re-ask.
      if (nodeName && warm && !options.fresh) {
        liveCache.set(key, fromCache(cached.sessions));
        clientCache.set(key, []);
        if (nodeName) {
          cachedNodes.add(nodeName);
          cachedAt.set(nodeName, { at: cached.at ?? null, age: cacheAgeMs, stale: cacheAgeMs >= ttlMs });
          if (cacheAgeMs >= ttlMs) staleNodes.push(nodeName);
        }
        return;
      }
      if (nodeName && !wanted.has(nodeName) && !asked && !options.sync) {
        // nothing written down for it and nothing cached: skip the trip
        askedNot.push(nodeName);
        liveCache.set(key, new Map());
        clientCache.set(key, []);
        return;
      }
      // no tmux, no answer: a machine without tmux is not a machine with
      // nothing running, but the table still has to come out
      const [sessions, clients] = await Promise.all([
        Promise.resolve()
          .then(() => handle.listSessionsStrict())
          .catch(() => null),
        Promise.resolve()
          .then(() => (nodeName ? handle.listClientsAsync() : handle.listClients()))
          .catch(() => []),
      ]).catch(() => [null, []]);
      if (sessions === null) {
        if (nodeName) unreachable.add(nodeName);
        // fall back to the last good answer rather than pretending it is empty
        if (cached) liveCache.set(key, fromCache(cached.sessions));
        else liveCache.set(key, new Map());
      } else {
        liveCache.set(key, sessions);
        if (nodeName) nodeCache[nodeName] = { at: Date.now(), sessions: asCache(sessions) };
      }
      clientCache.set(key, clients);
    }),
  );
  writeNodeCache(nodeCache);
  const liveFor = (nodeName) => liveCache.get(nodeName ?? "") ?? new Map();
  const clientsFor = (nodeName) => clientCache.get(nodeName ?? "") ?? [];

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
    const byRole = new Map();
    let broadcast = 0;
    for (const job of jobs) {
      if (job.action === "heal") continue;
      if (job.session === ALL_SESSIONS) {
        broadcast++;
        continue;
      }
      // a job aimed at a label reaches every session carrying it, so the column
      // has to count it there too — otherwise `cron add --role pm` looks like it
      // is aimed at nobody
      if (job.role) {
        byRole.set(String(job.role).toLowerCase(), (byRole.get(String(job.role).toLowerCase()) ?? 0) + 1);
        continue;
      }
      if (!job.session) continue;
      counts.set(job.session, (counts.get(job.session) ?? 0) + 1);
    }
    return (tmuxName, role = null) => {
      const viaRole = role ? byRole.get(String(role).toLowerCase()) ?? 0 : 0;
      const own = (counts.get(tmuxName) ?? 0) + viaRole;
      if (own && broadcast) return `${own}*`;
      if (own) return String(own);
      if (broadcast) return "*";
      return "";
    };
  })();

  const SORT_KEYS = new Set(["config", "idle", "name", "role"]);
  const sortKey = options.sort ?? config.sort ?? "config";
  if (!SORT_KEYS.has(sortKey)) {
    ui.error(`unknown --sort "${sortKey}" (try config, idle, name, role)`);
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

  // Whose sessions? By default this machine's: an operator looking at their own
  // box should not wait for six ssh round trips. `--node x` is one machine,
  // `--all` (or `--live`) is every machine that is written down.
  // Default scope: this machine, plus every machine `pp sync` already pulled.
  // Reading a cache costs nothing, so the table can be complete without ever
  // waiting on an ssh connection.
  const pulled = Object.keys(readNodeCache());
  let scope = options.all || options.live ? null : "";
  if (options.node) {
    // `--node 1` works like `pp node 1`: the number is on screen in `pp node ls`
    const picked = resolveNodeRef(config, options.node);
    if (!picked) {
      ui.error(`no node "${options.node}" — see pp node ls`);
      process.exit(2);
    }
    scope = picked.name;
    // selectSessions filters by name too, so hand it the name we resolved
    options = { ...options, node: picked.name };
  }
  const inScope = (session) => (scope === null ? true : (session.node ?? "") === scope);
  const scopeNodes =
    scope === null
      ? (config.nodes ?? []).map((node) => node.name)
      : scope
        ? [scope]
        : pulled.filter((name) => (config.nodes ?? []).some((node) => node.name === name));
  const localOnly = scope === "";
  const sessions = selectSessions(config, options.names, ui, { all: true, options }).filter((session) =>
    localOnly ? !session.node || scopeNodes.includes(session.node) : inScope(session),
  );
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
      role: session.role ?? null,
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
      cron: cronFor(session.tmuxName, session.role ?? null),
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

  // Sessions that are running on one of the configured machines but are not
  // written down. Without them `pp ls` on a Mac with one local session cannot
  // see the nine running on its node -- which is exactly the question it is
  // supposed to answer. They are read-only rows: attach and logs work, `up`
  // does not (there is nothing to start), `pp adopt` writes them down.
  const configuredKeys = new Set(config.sessions.map((session) => `${session.node ?? ""}:${session.tmuxName}`));
  const addStray = (nodeName, tmuxName, entry) => {
    const pane = entry?.panes?.[0] ?? null;
    const activity = entry?.activity ?? 0;
    const idleSeconds = activity ? Math.max(0, Math.round(Date.now() / 1000 - activity)) : null;
    rows.push({
      index: rows.length + 1,
      name: tmuxName,
      role: null,
      node: nodeName ?? "",
      tmux: tmuxName,
      todos: todoFor(tmuxName),
      state: pane?.dead ? "dead" : entry?.attached > 0 ? "attached" : "running",
      reason: "",
      restart: "-",
      pid: String(pane?.pid ?? ""),
      command: pane?.command ?? "",
      cwd: pane?.path ?? "",
      pi: false,
      piSession: "",
      piSessionName: "",
      activity,
      idleSeconds,
      idle: idleSeconds === null ? "" : shortAge(idleSeconds),
      remotePiName: "",
      cron: "",
      cwdMissing: false,
      lastStart: null,
      restarts: [],
      client: "",
      unmanaged: true,
    });
  };
  // Local unmanaged sessions stay in the footer only: they were always
  // discoverable with `pp adopt`, and promoting them to rows would renumber
  // every table on a busy machine. The rows are for *other* machines, which
  // had no way to be seen at all.
  for (const nodeName of scopeNodes) {
    for (const [tmuxName, entry] of liveFor(nodeName)) {
      if (configuredKeys.has(`${nodeName}:${tmuxName}`)) continue;
      addStray(nodeName, tmuxName, entry);
    }
  }

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
    // risk-2 before risk-10, and risk-01/risk-02/risk-pm next to each other
    shown = [...shown].sort((a, b) => compareNames(a.name, b.name));
  } else if (sortKey === "role") {
    // same label next to each other; unlabelled sessions sink to the bottom
    shown = [...shown].sort((a, b) => {
      const left = String(a.role ?? "");
      const right = String(b.role ?? "");
      if (left !== right) {
        if (!left) return 1;
        if (!right) return -1;
        return compareNames(left, right);
      }
      return compareNames(a.name, b.name);
    });
  }

  if (ui.json) {
    // the same two counts the footer shows, so a script does not have to
    // re-derive "is this machine still what the config says" from row states
    const jsonDown = rows.filter((r) => r.state === "off" || r.state === "stopped" || r.state === "dead").length;
    const jsonStrays = rows.filter((r) => r.unmanaged).map((r) => r.name);
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

  const configuredSet = new Set(config.sessions.map((session) => `${session.node ?? ""}:${session.tmuxName}`));
  const showNode = (config.nodes?.length ?? 0) > 0;
  // the CLIENT column only earns its width when somebody is actually attached
  const showClient = rows.some((row) => row.client);
  // so does CRON: a fleet with no schedules should not pay for the column
  const showCron = rows.some((row) => row.cron);
  // and TODOS: only when something is actually waiting somewhere
  const showTodos = rows.some((row) => row.todos);
  // ROLE is a label for humans, and only worth a column once someone uses it
  const showRole = rows.some((row) => row.role);
  // STARTED is opt-in: it answers "did it restart by itself?" not "is it up?"
  const showStarted = Boolean(options.started) && rows.some((row) => row.lastStart);
  // Three columns that are usually noise: a config of one stopped session was
  // printing two empty columns (PID, AGENT) and a REMOTE-PI column that just
  // repeated the name. They earn their width only when they say something.
  const showPid = rows.some((row) => row.pid && row.pid !== "-");
  const showAgent = rows.some((row) => row.command && row.command !== "-");
  const showRemotePi = rows.some((row) => row.remotePiName && row.remotePiName !== row.name);
  const headers = [
    ...(showNode ? ["#", "NAME", "NODE"] : ["#", "NAME"]),
    "STATE",
    "IDLE",
    "RESTART",
    ...(showPid ? ["PID"] : []),
    ...(showAgent ? ["AGENT"] : []),
    "CWD",
    "PI SESSION",
    ...(showRemotePi ? ["REMOTE-PI"] : []),
    ...(showRole ? ["ROLE"] : []),
    ...(showCron ? ["CRON"] : []),
    ...(showTodos ? ["TODOS"] : []),
    ...(showClient ? ["CLIENT"] : []),
    ...(showStarted ? ["STARTED"] : []),
  ];
  // A path is read from the right: /data/Yunxin/baohan/mango-risk tells you more
  // than /data/Yunxin/baohan/… does.
  const tailPath = (path, width = 30) => {
    const text = String(path ?? "");
    if (displayWidth(text) <= width) return text;
    let tail = "";
    for (const part of text.split("/").reverse()) {
      const next = tail ? `${part}/${tail}` : part;
      if (displayWidth(next) + 1 > width) break;
      tail = next;
    }
    return tail ? `…/${tail}` : `…${text.slice(-Math.max(1, width - 1))}`;
  };
  // The number must match the row it sits on: with `sort: name` a config-order
  // column reads 1,2,3,4,5,8,6,7,9 and looks like broken data.
  const numbered = shown.map((row, i) => ({ ...row, index: i + 1 }));
  const table = numbered.map((r) => [
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
    ...(showPid ? [r.pid] : []),
    ...(showAgent ? [r.command] : []),
    options.wide ? r.cwd : tailPath(r.cwd),
    !r.pi
      ? "-"
      : r.piSession
        ? options.wide
          ? `${r.piSessionName ? `${r.piSessionName} ` : ""}(${r.piSession})`
          : r.piSessionName
            ? `${r.piSessionName} (${String(r.piSession).slice(0, 8)}…)`
            : `(${String(r.piSession).slice(0, 8)}…)`
        : r.piSessionName
          ? `${r.piSessionName} (new)`
          : "(new)",
    ...(showRemotePi ? [r.remotePiName] : []),
    ...(showRole ? [r.role || "-"] : []),
    ...(showCron ? [r.cron || "-"] : []),
    ...(showTodos ? [r.todos ? String(r.todos) : "-"] : []),
    ...(showClient ? [r.client || "-"] : []),
    ...(showStarted ? [r.lastStart ? `${shortAge(Math.max(0, Math.round((Date.now() - Date.parse(r.lastStart.at)) / 1000)))} ${r.lastStart.why}` : "-"] : []),
  ]);
  // A table that does not fit the terminal is not a table: it wraps, and every
  // row becomes two lines of noise. Keep the columns that answer "is it up, how
  // long has it been quiet, where does it live", drop the rest, and truncate
  // what is left to the space available. `--wide` opts out for a file or a pipe.
  const CELL_LIMITS = { NAME: 28, CWD: 30, AGENT: 16, "PI SESSION": 20, "REMOTE-PI": 12, CLIENT: 20, ROLE: 16, STARTED: 14, NODE: 12 };
  const COLUMN_ORDER = ["#", "NAME", "STATE", "IDLE", "NODE", "CWD", "RESTART", "AGENT", "TODOS", "ROLE", "CRON", "CLIENT", "STARTED", "PID", "PI SESSION", "REMOTE-PI"];
  const cellWidth = (header, values) =>
    Math.min(CELL_LIMITS[header] ?? 40, Math.max(header.length, ...values.map((value) => displayWidth(value))));
  const budget = options.wide || !process.stdout.columns ? Infinity : Math.max(60, process.stdout.columns - 1);
  const keep = [];
  let used = 0;
  for (const name of COLUMN_ORDER) {
    const index = headers.indexOf(name);
    if (index === -1) continue;
    const width = cellWidth(name, table.map((row) => row[index]));
    const gap = keep.length ? 2 : 0;
    const base = name === "#" || name === "NAME" || name === "STATE" || name === "IDLE";
    if (used + gap + width <= budget || base) {
      keep.push(index);
      used += gap + width;
    }
  }
  keep.sort((a, b) => a - b);
  const hidden = headers.length - keep.length;
  const shownHeaders = keep.map((index) => headers[index]);
  const fitRows = table.map((row) => keep.map((index) => row[index]));
  const widths = shownHeaders.map((header, i) => cellWidth(header, fitRows.map((row) => row[i])));
  const pad = (value, width) => value + " ".repeat(Math.max(0, width - displayWidth(value)));
  const cell = (value, width) => pad(truncateWidth(value, width), width);
  const at = (name) => headers.indexOf(name);
  ui.out(ui.paint("bold", shownHeaders.map((h, i) => pad(h, widths[i])).join("  ").trimEnd()));
  numbered.forEach((row, i) => {
    const colored = [...table[i]];
    const stateAt = at("STATE");
    colored[0] = ui.paint("dim", colored[0]);
    if (showNode) colored[at("NODE")] = ui.paint(row.node ? "cyan" : "dim", colored[at("NODE")]);
    if (row.state === "off") colored[stateAt] = ui.paint("dim", colored[stateAt]);
    if (row.role) colored[at("ROLE")] = ui.paint("dim", colored[at("ROLE")]);
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
    ui.out(keep.map((index, i) => (index === stateAt ? pad(colored[index], widths[i]) : cell(colored[index], widths[i]))).join("  ").trimEnd());
  });
  if (hidden > 0) ui.info(`${hidden} column(s) did not fit ${process.stdout.columns} columns — pp ls --wide for all of them`);
  if (shown.length === 1 && shown[0].lastStart) {
    // one session was asked about: say who brought it back, and when
    const start = shown[0].lastStart;
    const ago = shortAge(Math.max(0, Math.round((Date.now() - Date.parse(start.at)) / 1000)));
    ui.out(
      ui.paint("dim", `last start ${ago} ago by ${start.why}${start.by ? ` (${start.by})` : ""}`),
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
    const unmanaged = [];
    for (const [key, map] of liveCache) {
      const nodeName = key === "local" ? "" : key;
      for (const name of map.keys()) {
        // rows already carry the other machines' strays: only the local ones
        // (which stay in the footer) are collected here
        if (!nodeName && !configuredSet.has(`:${name}`)) unmanaged.push(name);
      }
    }
    const width = process.stdout.columns && !options.wide ? Math.max(40, process.stdout.columns - 1) : Infinity;
    const short = (text) => (width === Infinity ? text : truncateWidth(text, width));
    const notes = [];
    const downText = down ? `  ${ui.paint("yellow", formatDownReasons(downReasons(rows)))}` : "";
    const extras = [];
    const compact = [];
    const rowStrays = rows.filter((row) => row.unmanaged).map((row) => `${row.name}@${row.node}`);
    const allStrays = [...rowStrays, ...unmanaged];
    if (allStrays.length) {
      extras.push(ui.paint("yellow", `${allStrays.length} unmanaged`));
      notes.push(
        `${allStrays.length} unmanaged session(s) are in tmux but not in the config: ${allStrays.slice(0, 3).join(", ")}${allStrays.length > 3 ? ", …" : ""} — pp adopt${rowStrays.length ? ` (the @one ones are on another machine: pp adopt --node ${rowStrays[0].split("@")[1]})` : ""}`,
      );
    }
    if (config.nodes?.length) {
      const asked = config.nodes.length - askedNot.length - cachedNodes.size;
      const parts = [`${asked} asked`];
      if (cachedNodes.size) parts.push(`${cachedNodes.size} cached`);
      if (askedNot.length) parts.push(`${askedNot.length} not asked`);
      extras.push(ui.paint("dim", `${shown.filter((row) => row.node).length} on ${new Set(shown.filter((row) => row.node).map((row) => row.node)).size} other machine(s) · ${parts.join(", ")}`));
    }
    if (unreachableNodes.length) extras.push(ui.paint("red", `unreachable: ${unreachableNodes.join(", ")}`));
    ui.out(short(`\n${running}/${shown.length} running${downText}${extras.length ? `  ${extras.join("  ")}` : ""}  ${ui.paint("dim", `config: ${config.path}`)}`));
    if (sortKey !== "config" && shown.length) notes.push(`sorted by ${sortKey}; # is the row number you are looking at`);
    if (rows.some((r) => r.reason === "hand")) notes.push("(hand) = stopped on purpose; pp up <name> brings it back");
    if (rows.some((r) => r.reason === "drain")) notes.push("(drain) = machine under maintenance; pp node undrain <name> lets it start");
    if (showCron) notes.push("cron: jobs aimed here (* = every session)");
    // Unmanaged rows have no config entry, so RESTART and PI SESSION are "-":
    // say what "-" means once, with the one command that fills them in.
    const unmanagedRows = rows.filter((row) => row.unmanaged);
    if (unmanagedRows.length) {
      const nodes = [...new Set(unmanagedRows.map((row) => row.node).filter(Boolean))];
      notes.push(
        `- in RESTART / PI SESSION means "not written down": these ${unmanagedRows.length} run on ${nodes.join(", ") || "another machine"} but are not in ${config.path} yet — pp adopt${nodes.length === 1 ? ` --node ${nodes[0]}` : ""}`,
      );
    }
    // asked about, but nothing written down for it
    const idleNodes = (config.nodes ?? [])
      .filter((node) => !askedNot.includes(node.name) && !shown.some((row) => row.node === node.name))
      .map((node) => node.name);
    if (idleNodes.length) {
      compact.push(`${idleNodes.length} idle machine(s)`);
      notes.push(`no session on ${idleNodes.join(", ")} yet — pp new --node ${idleNodes[0]} -C <dir> --save   (pp fleet shows what runs there)`);
    }
    if (staleNodes.length) {
      const worst = staleNodes
        .map((name) => `${name} ${cachedAt.get(name)?.age ? shortAge(Math.round((cachedAt.get(name).age ?? 0) / 1000)) : "?"}`)
        .slice(0, 4)
        .join(", ");
      compact.push(`cached ${worst.split(",")[0].trim()}`);
      notes.push(`cached: ${worst}${staleNodes.length > 4 ? ", …" : ""} — pp sync refreshes it (pp ls --live asks now)`);
    }
    // not asked this time: say so, and say how to ask
    if (askedNot.length) {
      compact.push(`${askedNot.length} not asked`);
      notes.push(
        `${askedNot.length} machine(s) not asked: ${askedNot.slice(0, 3).join(", ")}${askedNot.length > 3 ? ", …" : ""} — pp ls --node <name|#> for one, --live for all`,
      );
    }
    // One line by default: the counts are the news, the prose is homework.
    // `pp ls -v` prints the sentences that say what to type.
    if (allStrays.length) compact.unshift(`${allStrays.length} unmanaged`);
    if (options.verbose) {
      for (const note of notes) ui.info(ui.paint("dim", short(note)));
    } else if (compact.length) {
      ui.info(ui.paint("dim", short(`${compact.join(" · ")}  — pp ls -v for what to do`)));
    }
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

/**
 * The machines worth asking for a session list: the ones that actually carry a
 * configured session. A registered machine with nothing on it still appears in
 * `pp node ls` and `pp doctor --nodes`; asking it on every frame costs ~350 ms
 * of ssh, which is how the panel ended up redrawing slower than its own timer.
 */
export function nodesToProbe(config) {
  const used = new Set((config?.sessions ?? []).map((session) => session.node).filter(Boolean));
  return (config?.nodes ?? []).map((node) => node.name).filter((name) => used.has(name));
}


/** Bytes free on the filesystem holding `dir`, or null when node is too old. */
export function freeSpace(dir) {
  try {
    const stats = statfsSync(dir);
    return { bytes: Number(stats.bavail) * Number(stats.bsize), mount: dir };
  } catch {
    return null;
  }
}

/** Below this, a machine has minutes rather than days (PP_DISK_MIN_MB, 1 GB). */
export function diskFloorBytes(env = process.env) {
  const raw = Number(env.PP_DISK_MIN_MB);
  const megabytes = Number.isFinite(raw) && raw > 0 ? raw : 1024;
  return megabytes * 1024 * 1024;
}

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

export function tuiSessionRows(config, live, { stuck = null, owner = null } = {}) {
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
    const isStuck = stuck?.has(session.tmuxName) ?? false;
    const idleStale = idle !== null && idle >= staleSeconds();
    const stale = (idleStale || isStuck) && state !== "off" && state !== "dead";
    rows.push({
      name: session.tmuxName,
      role: session.role ?? "",
      node: session.node ?? "",
      state,
      activity: entry?.activity ?? 0,
      age,
      stale,
      idleSeconds: idle === null ? null : Math.round(idle),
      todos: waiting(session.tmuxName),
      node: session.node ?? owner?.get(session.tmuxName) ?? "",
      label: `${String(config.sessions.indexOf(session) + 1).padStart(2)} ${session.tmuxName}${session.node ? ` @${session.node}` : ""}  ${state}`,
      dim: state === "off" || state === "dead",
      warn: stale,
      stuck: isStuck,
    });
  }
  for (const [name, entry] of live) {
    if (seen.has(name)) continue;
    // a session pp itself spawned to do a job (or a shell) is not an agent the
    // panel is about: showing it just pushes the real rows off the screen
    const runsPi = (entry?.panes ?? []).some((pane) => /(^|\/)pi$|(^|\/)pi\s/.test(String(pane?.command ?? "")));
    if (!runsPi) continue;
    const state = stateOf(entry);
    const age = entry?.activity ? shortAge(Date.now() / 1000 - entry.activity) : "";
    rows.push({
      name,
      node: owner?.get(name) ?? "",
      state,
      activity: entry?.activity ?? 0,
      age,
      label: ` - ${name}${owner?.get(name) ? ` @${owner.get(name)}` : ""}  ${state}`,
      // grey means "not running" everywhere else in this panel; an unmanaged
      // session that is up is up, so the leading "-" is what marks it
      dim: state === "off" || state === "dead",
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
  /**
   * The panel redraws every second; an ssh round trip is ~350 ms, so probing a
   * fleet of machines on every frame is what made it feel stuck (six nodes =
   * two seconds of ssh per tick). Only machines that actually carry a session
   * are asked, and their answers are kept for a few seconds.
   */
  const REMOTE_TTL_MS = 5000;
  const remoteCache = new Map();
  // what `pp sync` wrote down for each machine (empty when it never ran)
  let syncCache = readNodeCache();
  /**
   * Sessions whose agent is mid-turn but has printed nothing for the stall
   * window. The list already shows `!` for "no output at all" (window_activity),
   * but a stuck agent keeps repainting its spinner, so window_activity stays
   * fresh — only the *content* signature can tell. Costs two captures per local
   * session, so it is cached; remote sessions are left to `pp doctor`.
   */
  const STUCK_TTL_MS = 10000;
  let stuckCache = { at: 0, names: new Set() };
  const stuckNow = () => {
    if (Date.now() - stuckCache.at < STUCK_TTL_MS) return stuckCache.names;
    const names = new Set();
    const limit = stallMinutes();
    for (const session of config.sessions.filter((entry) => !entry.node)) {
      try {
        const handle = makeTmux(config, options, session);
        if (!handle.sessionExists(session.tmuxName)) continue;
        const watch = stallWatch(config, handle, session);
        if (watch?.busy && watch.quiet >= limit) names.add(session.tmuxName);
      } catch {
        // an unreachable pane is the drift check's business
      }
    }
    stuckCache = { at: Date.now(), names };
    return names;
  };
  // every configured machine is asked, not only the ones that already have a
  // session in the config: a session that is running there but not written down
  // is exactly what the panel should show
  // The panel is about one machine at a time. Local by default: a refresh
  // every second must not be six ssh round trips. `n` cycles the scope.
  const scopes = ["", ...(config.nodes ?? []).map((node) => node.name)];
  let scopeIndex = 0;
  const scope = () => scopes[scopeIndex] ?? "";
  // The panel shows sessions from every machine `pp sync` has pulled, not only
  // the ones the config names: on a laptop the interesting sessions all live on
  // one box that the config may never mention.
  const nodesInUse = () => {
    const pulled = Object.keys(readNodeCache());
    const known = (config.nodes ?? []).map((node) => node.name);
    const useful = known.filter((name) => pulled.includes(name) || nodesToProbe(config).includes(name));
    return scope() ? [scope()] : useful;
  };
  const readLive = ({ fresh = false } = {}) => {
    const live = new Map();
    const owner = new Map();
    for (const nodeName of [null, ...nodesInUse()]) {
      const cached = nodeName === null ? null : remoteCache.get(nodeName);
      // `pp sync` already pulled this: a panel that redraws every second has no
      // business opening an ssh connection to answer the same question
      const pulled = nodeName === null ? null : syncCache[nodeName];
      let map;
      if (!fresh && cached && Date.now() - cached.at < REMOTE_TTL_MS) {
        map = cached.map;
      } else if (!fresh && pulled) {
        map = fromCache(pulled.sessions);
        remoteCache.set(nodeName, { at: Date.now(), map });
      } else {
        try {
          map = makeTmux(config, options, { node: nodeName }).listSessions();
          if (nodeName !== null) remoteCache.set(nodeName, { at: Date.now(), map });
        } catch {
          // keep the last answer we had: an unreachable machine should not
          // erase its sessions from the panel
          if (!cached) continue;
          map = cached.map;
        }
      }
      for (const [name, entry] of map) {
        if (live.has(name)) continue;
        live.set(name, entry);
        owner.set(name, nodeName);
      }
    }
    sessionOwner = owner;
    return { live, owner, tmuxFor: (name) => makeTmux(config, options, { node: owner.get(name) ?? null }) };
  };

  if (once) {
    const cols = process.stdout.columns || 100;
    const rows = process.stdout.rows || 30;
    // the todo box grows with its content, so its size has to be known before
    // the layout: the snapshot used to clip the second todo and say nothing
    const onceTodos = tuiTodoRows(filterTodos(readTodos()), Date.now());
    const { live, owner } = readLive();
    const sortKey = options.sort ?? config.sort ?? "config";
    const sessionRows = ordered(tuiSessionRows(config, live, { stuck: stuckNow(), owner }), sortKey);
    const onceCounts = new Map();
    for (const row of sessionRows) onceCounts.set(row.node ?? "", (onceCounts.get(row.node ?? "") ?? 0) + 1);
    const onceHost = new Map((config.nodes ?? []).map((node) => [node.name, node.host ?? ""]));
    const onceNodes = ["", ...(config.nodes ?? []).map((node) => node.name)].map((name, index) => {
      const host = name ? onceHost.get(name) || "" : "";
      return { name, index, label: truncateWidth(`${name || "local"} ${host}`, 27), dim: !name };
    });
    const layout = computeLayout(cols, rows, { leftWidth, todoCount: onceTodos.length, nodes: onceNodes.length });
    function ordered(rows, key) {
      // --once should show the same order the live panel would
      if (key === "name") return [...rows].sort((a, b) => compareNames(a.name, b.name));
      if (key === "idle") return [...rows].sort((a, b) => (b.idleSeconds ?? -1) - (a.idleSeconds ?? -1));
      if (key === "role") {
        return [...rows].sort((a, b) => {
          const left = String(a.role ?? "");
          const right = String(b.role ?? "");
          if (left !== right) {
            if (!left) return 1;
            if (!right) return -1;
            return compareNames(left, right);
          }
          return compareNames(a.name, b.name);
        });
      }
      return rows;
    }
    // same drift sentence as the live panel, so --once is a fair sample
    const onceOff = sessionRows.filter((row) => row.state === "off" || row.state === "dead" || row.state === "stopped").length;
    const onceStrays = sessionRows.filter((row) => row.unmanaged).length;
    const onceDrift = [onceOff ? `${onceOff} off` : null, onceStrays ? `${onceStrays} unmanaged` : null].filter(Boolean).join(" · ");
    const cacheAge = (() => {
      const cache = readNodeCache();
      const ages = Object.entries(cache)
        .map(([name, entry]) => [name, Date.now() - Date.parse(entry.at ?? 0)])
        .filter(([, ms]) => Number.isFinite(ms));
      if (!ages.length) return "no cache — pp sync";
      // the freshest entry is the honest headline; negative means a clock skew
      const [name, raw] = ages.sort((a, b) => a[1] - b[1])[0];
      const ms = Math.max(0, raw);
      if (!Number.isFinite(ms)) return `cache ${name} aged ?`;
      const minutes = Math.floor(ms / 60000);
      return minutes >= 1 ? `cache ${name} ${minutes}m` : `cache ${name} ${Math.floor(ms / 1000)}s`;
    })();
    const model = {
      nodes: onceNodes,
      sessions: sessionRows,
      todos: onceTodos,
      machines: machineSummary(sessionRows),
      focus: "sessions",
      footer: `${onceDrift ? `${onceDrift} · ` : ""}${cacheAge} · pp tui --once`,
    };
    for (const line of renderFrame(model, layout)) ui.out(line);
    return;
  }

  let visibleCache = { at: 0, visible: true };
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
  const traceMs = [];
  tui = createTui({
    version: options.version ?? "",
    leftWidth,
    sort: options.sort ?? config.sort ?? "config",
    intervalMs: options.refreshSeconds ? Math.round(Number(options.refreshSeconds) * 1000) : 1000,
    staticMode: Boolean(options.staticPanel),
    // a frame that did not fit stretches the interval; that is all we can do now
    // that there is no preview to drop,
    trace: (sample) => {
      traceMs.push(sample);
      if (traceMs.length > 200) traceMs.shift();
      if (options.trace) {
        try {
          appendFileSync(options.trace, `${new Date().toISOString()} ${JSON.stringify(sample)}\n`);
        } catch {
          // a trace that cannot be written must not break the panel
        }
      }
    },
    io: {
      input: process.stdin,
      output: process.stdout,
      isTTY: Boolean(process.stdin.isTTY),
      size: screenSize,
      onResize: (callback) => process.stdout.on("resize", callback),
      async cycleScope() {
        scopeIndex = (scopeIndex + 1) % scopes.length;
        remoteCache.clear();
        return scope() || "local";
      },
      async selectNode(delta) {
        scopeIndex = (scopeIndex + delta + scopes.length) % scopes.length;
        remoteCache.clear();
        return scope() || "local";
      },
      /** Enter on a machine row: log into it, the same way `pp node <n>` does. */
      async enterNode(picked = "") {
        const name = picked ?? "";
        if (!name) return "this machine is the one you are on";
        const node = (config.nodes ?? []).find((entry) => entry.name === name);
        if (!node) return `no node "${name}" — see pp node ls`;
        const inv = sshInvocation(node, [], { tty: true, batch: false });
        const result = spawnSync(inv.command, inv.argv, { stdio: "inherit", env: { ...process.env, ...(inv.env ?? {}) } });
        if (result.error) return `could not log into ${name}: ${result.error.message}`;
        return result.status === 0 ? `back from ${name}` : `ssh to ${name} exited ${result.status}`;
      },
      async refresh({ index = 0 } = {}) {
        const { live, owner } = readLive();
        // Every session, from every machine: the machines column is a shortcut
        // to a shell there, not a filter on the list beside it.
        const sessions = tuiSessionRows(config, live, { stuck: stuckNow(), owner });
        const counts = new Map();
        for (const row of sessions) counts.set(row.node ?? "", (counts.get(row.node ?? "") ?? 0) + 1);
        const hostOf = new Map((config.nodes ?? []).map((node) => [node.name, node.host ?? ""]));
        const nodes = ["", ...(config.nodes ?? []).map((node) => node.name)].map((name, index) => {
          const host = name ? hostOf.get(name) || "" : "";
          return { name, index, label: truncateWidth(`${name || "local"} ${host}`, 27), dim: !name };
        });
        const todos = tuiTodoRows(filterTodos(readTodos()), Date.now());
        // no pane capture: the panel lists what exists, tmux draws the rest
        return { sessions, todos, nodes };
      },
      /**
       * Is this pane on screen right now? After `attach` the client is looking at
       * some other session; painting our hidden pane from a timer is what made
       * coming back look frozen (a backlog of frames).
       */
      visible: () => {
        if (!process.env.TMUX) return true;
        if (Date.now() - visibleCache.at < 1000) return visibleCache.visible;
        const out = process.env.TMUX_PANE
          ? (() => {
            try {
              // `#{window_visible}` does not exist (it expands to an empty
              // string and every frame was treated as invisible), so ask for the
              // thing that does: is anyone attached at all. Deliberately not
              // `pane_active`/`window_active`: a panel pane that shares a window
              // with session panes, or a window that is not the front one, is
              // still a pane someone will come back to — skipping its drawing
              // made /pp-back look like a freeze. Our frames never scroll (no
              // wrap, absolute addressing), so drawing costs CPU, not correctness.
              const result = spawnSync("tmux", ["display-message", "-p", "-t", process.env.TMUX_PANE, "#{session_attached}"], { encoding: "utf8" });
              return result.status === 0 ? result.stdout : null;
            } catch {
              return null;
            }
          })()
          : null;
        const visible = out === null ? true : String(out).trim().split(/\s+/).every((part) => part === "1");
        visibleCache = { at: Date.now(), visible };
        return visible;
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
  // Ctrl-C, `kill`, or a closing terminal would otherwise leave the shell in raw
  // mode with the cursor hidden and the alternate screen still up
  const onSignal = (signal) => {
    tui.restoreTerminal();
    ui.error(`stopped by ${signal}`);
    process.exit(128 + (signal === "SIGINT" ? 2 : signal === "SIGHUP" ? 1 : 15));
  };
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.once(signal, () => onSignal(signal));
  try {
    await tui.start();
  } finally {
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.removeAllListeners(signal);
    tui.restoreTerminal();
  }
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
  const diagLayout = computeLayout(screen.cols, screen.rows, {
    leftWidth: options.left === undefined ? 0 : parseLeftOption(options.left, screen.cols),
    todoCount: readTodos().length,
    nodes: (config.nodes ?? []).length + 1,
  });
  const layout = diagLayout;

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
    `  layout         ${layout.mode} — sessions ${layout.sessions.w}x${layout.sessions.h}, todo ${layout.todos.h} rows`,
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
  // A row number is a shortcut for the name in that row of `pp ls`: resolve it
  // to the session (and its machine) and use that from here on.
  const [session] = selectSessions(config, [name], ui, { options });
  if (options.verbose && String(name) !== session.name) ui.info(`#${name} is ${session.name}${session.node ? ` on ${session.node}` : ""}`);
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

/**
 * `pp why --node t114`: the same question one level up — why is half this
 * machine's fleet not up. Sessions are listed with their own verdict, so the
 * answer reads top to bottom: the machine, then each session's reason.
 */
/**
 * Where a scheduled job is aimed, and whether that address still exists. A job
 * keeps the name it was written with; sessions get renamed, machines get drained
 * and roles get dropped, so "it says delivered to `w`, but `w` is gone" is the
 * single most common way a schedule silently stops being useful.
 */
export function describeJobTarget(config, job, { running = () => null } = {}) {
  if (job.action === "heal") return { text: "the drift — what the config expects and the machine does not have (pp up --drift does it once)", ok: true };
  if (job.action === "command") return { text: `$ ${job.command} (on this machine, killed after ${job.timeout ?? COMMAND_TIMEOUT_SECONDS}s)`, ok: true };
  if (job.action === "sweep") {
    const report = (config?.sessions ?? []).find((entry) => entry.name === job.session || entry.tmuxName === job.session);
    if (!report) return { text: `fleet report → "${job.session}", which is not in the config (pp cron retarget ${job.id} --session <name>)`, ok: false };
    return { text: `fleet report → ${report.name}${report.node ? ` on ${report.node}` : ""}`, ok: true };
  }
  if (job.role) {
    const carriers = roleTargets(config, job.role);
    if (!carriers.length) return { text: `role "${job.role}", which no session carries (pp cron retarget ${job.id} --role <label>)`, ok: false };
    const names = carriers.map((entry) => entry.name).slice(0, 4).join(", ");
    const more = carriers.length > 4 ? ` (+${carriers.length - 4})` : "";
    return { text: `role "${job.role}" — ${carriers.length} session(s): ${names}${more}`, ok: true };
  }
  if (!job.session || job.session === ALL_SESSIONS) {
    const total = (config?.sessions ?? []).length;
    return { text: `every session — ${total} in the config`, ok: true };
  }
  const session = (config?.sessions ?? []).find((entry) => entry.name === job.session || entry.tmuxName === job.session);
  if (!session) return { text: `session "${job.session}", which is gone from the config (pp cron retarget ${job.id} --session <name>)`, ok: false };
  const where = session.node ? ` on ${session.node}` : "";
  const state = running(session.tmuxName, session.node ?? null);
  const tail = state === true ? "running" : state === false ? `not running — pp up ${session.name}` : "state unknown";
  return { text: `${session.name}${where} — ${tail}`, ok: true };
}

/**
 * `pp why <job-id>`: the same question as `pp why <session>`, asked about a
 * scheduled job — "it did not deliver, why".
 */
export async function cmdWhyJob(config, options, ui, job) {
  const now = new Date();
  const due = nextRun(job, now);
  const next = describeNext(due, now);
  const status = String(job.lastStatus ?? "");
  const busyTarget = (() => {
    if (!job.session || job.session === ALL_SESSIONS) return false;
    const session = config.sessions.find((entry) => entry.name === job.session || entry.tmuxName === job.session);
    if (!session) return false;
    try {
      return makeTmux(config, options, session).isAgentBusy(session.tmuxName);
    } catch {
      return false;
    }
  })();
  const tick = (() => {
    try {
      return crondHasBlock(readCrontab());
    } catch {
      return false;
    }
  })();

  let verdict;
  if (job.done) verdict = `finished — it ran once, ${job.lastRun ? agoText(job.lastRun, now) : "and will not run again"}`;
  else if (!tick) verdict = "the tick is not in crontab, so nothing will ever fire — pp install";
  else if (status.startsWith("deferred:")) verdict = `waiting: ${status.replace(/^deferred:\s*/, "")}`;
  else if (status.startsWith("failed:")) {
    const said = status.replace(/^failed:\s*/, "");
    verdict =
      job.action === "command"
        ? `the last run failed: ${said} — pp cron run ${job.id} to try it again`
        : `the last run failed: ${said} — pp logs ${job.session ?? "<session>"}`;
  }
  else if (status.startsWith("skipped: missed"))
    verdict = `it was missed for longer than its catch-up window (${formatDuration(job.catchUp ?? DEFAULT_CATCH_UP_SECONDS)}) — it resumes at the next scheduled time`;
  else if (busyTarget) verdict = `its target is mid-turn right now, so the next tick will queue or skip — nothing to do`;
  else if (next.late) verdict = `overdue by ${next.late} — the tick may not be running: pp doctor`;
  else verdict = `healthy — next ${next.text}`;

  // Would it land right now? That is the question the schedule cannot answer, and
  // the one that explains a job that "runs" while nobody hears it.
  const liveNow = new Map();
  for (const nodeName of [null, ...(config?.nodes ?? []).map((node) => node.name)]) {
    try {
      liveNow.set(nodeName ?? "", makeTmux(config, options, { node: nodeName }).listSessions());
    } catch {
      liveNow.set(nodeName ?? "", null);
    }
  }
  const plan = (() => {
    if (job.action !== "prompt") return null;
    try {
      if (job.role) {
        const targets = [];
        let note = null;
        for (const session of roleTargets(config, job.role)) {
          const own = makeTmux(config, options, session);
          const one = deliveryPlan(own, { ...job, role: null, session: session.tmuxName }, { config });
          targets.push(...one.targets);
          if (one.note) note = one.note;
        }
        return { targets, note };
      }
      if (!liveNow.get("")) return { targets: [], note: "tmux is not answering here" };
      return deliveryPlan(makeTmux(config, options), job, { config });
    } catch (err) {
      return { targets: [], note: err.message };
    }
  })();
  const wouldReach = plan
    ? { send: plan.targets.filter((entry) => entry.verdict === "send").length, total: plan.targets.length, note: plan.note ?? null }
    : null;

  if (ui.json) {
    ui.out(
      JSON.stringify(
        {
          id: job.id,
          action: job.action ?? null,
          target: job.session ?? null,
          schedule: job.schedule,
          catchUp: job.catchUp ?? null,
          idleAfter: job.idleAfter ?? null,
          maxPerDay: job.maxPerDay ?? null,
          dayRuns: dailyRuns(job, new Date(now)),
          verdict,
          tick,
          nextRun: due ? due.toISOString() : null,
          lastRun: job.lastRun ?? null,
          lastAttempt: job.lastAttempt ?? null,
          lastStatus: job.lastStatus ?? null,
          runs: job.runs ?? 0,
          skipped: job.skipped ?? 0,
          busyTarget,
          targetDetail: describeJobTarget(config, job, { running: () => null }).text,
          wouldReach,
        },
        null,
        2,
      ),
      null,
    );
    return;
  }

  const line = (label, text) => ui.out(`${ui.paint("dim", label.padEnd(9))}${text}`);
  const when =
    job.schedule.kind === "every"
      ? `every ${formatDuration(job.schedule.every)}`
      : job.schedule.kind === "cron"
        ? job.schedule.cron
        : "once";
  ui.out(`${ui.paint("bold", job.id)}  ${ui.paint("dim", `${when} · ${job.action === "heal" ? "heal drift" : job.action === "command" ? "a command on this machine" : job.session === ALL_SESSIONS ? "all sessions" : job.action === "sweep" ? `fleet → ${job.session}` : job.role ? `role ${job.role}` : `to ${job.session ?? "-"}`}`)}`);
  line("state", status.startsWith("failed:") ? ui.paint("red", verdict) : verdict);
  const liveCache = new Map();
  const liveFor = (nodeName) => {
    const key = nodeName ?? "";
    if (liveCache.has(key)) return liveCache.get(key);
    let map = null;
    try {
      map = makeTmux(config, options, { node: nodeName }).listSessions();
    } catch {
      map = null;
    }
    liveCache.set(key, map);
    return map;
  };
  const aim = describeJobTarget(config, job, {
    running: (name, node) => {
      const map = liveFor(node);
      return map ? map.has(name) : null;
    },
  });
  line("target", aim.ok ? aim.text : ui.paint("yellow", aim.text));
  line("schedule", `${when}${job.window ? ui.paint("dim", ` · silent ${describeWindow(job.window)}`) : ""}${job.idleAfter ? ui.paint("dim", ` · only after ${formatDuration(job.idleAfter)} of quiet`) : ""}${job.catchUp ? ui.paint("dim", ` · catch-up ${formatDuration(job.catchUp)}`) : ""}`);
  // same courtesy as the table: a deferred job is waiting for its target, not late
  const deferredJob = String(job.lastStatus ?? "").startsWith("deferred:");
  const nextText = deferredJob && next.late ? next.text.replace(/^late [^(]*\(/, "waiting (") : next.text;
  line(
    "next",
    nextText === "-"
      ? "-"
      : `${nextText}${next.late && !deferredJob ? ui.paint("yellow", "  (late)") : deferredJob ? ui.paint("dim", "  (retries every tick)") : ""}`,
  );
  line("last run", job.lastRun ? `${agoText(job.lastRun, now)}${job.lastStatus ? ui.paint("dim", ` — ${job.lastStatus}`) : ""}` : "never");
  const today = dailyRuns(job, new Date(now));
  const capText = job.maxPerDay ? ` · today ${today} of ${job.maxPerDay}` : today ? ` · today ${today}` : "";
  line("counts", `ran ${job.runs ?? 0}× · skipped ${job.skipped ?? 0}×${capText}`);
  if (job.lastOutput) {
    // what the command actually said: "exit 3" alone sends you looking for the script
    line("output", String(job.lastOutput).split("\n").slice(-4).join("\n           "));
  }
  if (inQuietHours(job, now)) {
    line("now", ui.paint("dim", `quiet hours — nothing is sent until ${describeWindow(job.window).split("-").pop()}`));
  } else if (plan) {
    if (plan.note) {
      line("now", ui.paint("yellow", plan.note));
    } else {
      const send = plan.targets.filter((entry) => entry.verdict === "send").length;
      const only = plan.targets.length === 1 && send === 1;
      line(
        "now",
        only
          ? ui.paint("green", "would send")
          : `${ui.paint(send ? "cyan" : "dim", `would reach ${send} of ${plan.targets.length}`)}${plan.targets.some((entry) => entry.verdict === "lately") ? ui.paint("dim", " — the rest moved recently") : ""}${plan.targets.some((entry) => entry.verdict === "busy") ? ui.paint("dim", " — some are mid-turn") : ""}`,
      );
    }
  }
  line("look", `pp cron show ${job.id} · pp logs ${job.session && job.session !== ALL_SESSIONS ? job.session : "<session>"}`);
}


/**
 * `pp plan`: the same facts as `doctor`, `why` and `status`, but ordered.
 *
 * `pp doctor --brief` names the first thing to do; a fleet is usually several
 * things at once, and the useful question is "in what order". Steps are ranked
 * by what blocks the most work: a machine you cannot reach hides everything on
 * it, a drained machine makes every `up` a no-op, and so on. Read-only.
 */
export function planSteps(facts) {
  // `waiting` is the stale-todo list; `deferred` is cron jobs stuck behind a busy target
  const { reach = [], drift = [], unmanaged = [], stuck = [], cron = [], dangling = [], waiting = [], deferred = [], logs = [], autostart = null, extension = null, disk = null, tick = null } = facts;
  const steps = [];
  const add = (priority, title, command, why) => steps.push({ priority, title, command, why });

  for (const machine of reach) {
    if (machine.how === "unknown") {
      add(0, `no machine named "${machine.name}"`, "pp node ls", "a machine has to be in `nodes:` in the config before anything can run there");
      continue;
    }
    if (machine.how === "tmux-missing") {
      add(0, `${machine.name} has no tmux, so nothing can run there`, `apt install tmux (on ${machine.name})`, "sessions live in tmux; without it pp has nowhere to put them");
      continue;
    }
    const local = machine.how === "tmux";
    add(
      0,
      `reach ${machine.name} — ${local ? "tmux is not answering" : "ssh failed"}`,
      local ? "pp doctor" : `pp node test ${machine.name}`,
      local ? "nothing on this machine can be seen until tmux answers" : "nothing on that machine can be fixed until ssh works",
    );
  }
  for (const machine of drift.filter((entry) => entry.drained && entry.down > 0)) {
    add(1, `undrain ${machine.name} — ${machine.down} session(s) waiting`, `pp node undrain ${machine.name}`, "a drained machine ignores pp up");
  }
  if (autostart && !autostart.enabled) {
    add(2, "install the autostart unit", "pp install", "sessions only come back after a reboot once this exists");
  }
  if (extension && extension.stale) {
    add(3, `upgrade the pi extension to ${extension.want}`, extension.command, "the /pp-* commands come from the extension, not the cli");
  }
  // ahead of every late job: if nothing calls the tick, "late" is a symptom with
  // one cause, and running individual jobs one at a time does not fix it
  if (tick) {
    add(
      1,
      tick.broken
        ? `${tick.jobs} scheduled job(s), but the tick cannot run — ${tick.broken}`
        : `${tick.jobs} scheduled job(s) exist but nothing calls the tick`,
      "pp cron install",
      tick.broken
        ? "the crontab line still names the old node or pp.js path, so every job looks on time and nothing runs"
        : "without the crontab line every job sits there looking on time and never runs",
    );
  }
  for (const job of dangling) {
    add(
      4,
      `${job.id} is aimed at ${job.missing ?? "something"}, which nothing carries`,
      `pp cron retarget ${job.id} ${(job.missing ?? (job.role ? 'role ""' : "session")).startsWith("role") ? "--role" : "--session"} <the name now>`,
      "the target is gone, so this job ticks and reaches nobody — retargeting keeps its history",
    );
  }
  for (const job of cron) {
    add(4, `${job.id} is ${job.late} late`, `pp cron run ${job.id}`, "the tick may not be firing, or this one is stuck behind a busy target");
  }
  for (const job of deferred) {
    // "deferred" is the polite word for "this has not landed since 02:40"
    add(6, `${job.id} has been waiting on ${job.session} for ${job.how}`, `pp why ${job.id}`, "the target never frees up, so either it needs attention or the job belongs elsewhere");
  }
  const off = drift.filter((entry) => entry.down > 0 && !entry.drained);
  if (off.length) {
    const total = off.reduce((sum, entry) => sum + entry.down, 0);
    // one machine asked about: name it, so the command cannot be mistyped on a
    // fleet of nine
    const single = off.length === 1 && off[0].name !== "this machine";
    add(
      5,
      `start ${total} session(s) that should be up`,
      single ? `pp up --node ${off[0].name}` : "pp up --drift",
      `off on ${off.map((entry) => entry.name).join(", ")}`,
    );
  }
  if (unmanaged.length) {
    // entries on a machine are `name@node`: adopt them from that machine
    const nodes = [...new Set(unmanaged.filter((name) => name.includes("@")).map((name) => name.split("@").pop()))];
    const command = nodes.length === 1 && unmanaged.length === unmanaged.filter((name) => name.endsWith(`@${nodes[0]}`)).length
      ? `pp adopt --node ${nodes[0]}`
      : "pp adopt";
    add(6, `adopt ${unmanaged.length} session(s) that are not in the config`, command, `running but unwritten: ${unmanaged.slice(0, 4).join(", ")}`);
  }
  if (disk) {
    add(
      1,
      `${disk.free} free — below the ${disk.want} floor`,
      "pp clean",
      "a full disk makes every other fix fail quietly; pp clean shrinks the files pp wrote",
    );
  }
  for (const item of stuck) {
    add(7, `${item.name} has been quiet for ${item.quiet}m`, `pp logs ${item.name}`, "the agent is mid-turn and may be waiting on a tool");
  }
  if (waiting.length) {
    const oldest = waiting[0];
    add(
      8,
      `${waiting.length} question(s) are waiting for an answer — oldest ${oldest.age}`,
      "pp todo ls",
      "an agent asked something and is still holding the thread; the answer is the only thing that unblocks it",
    );
  }
  for (const file of logs) {
    add(9, `${file.label} is ${file.size}`, "pp clean", `nothing rotates it; a full disk breaks everything`);
  }
  return steps.sort((a, b) => a.priority - b.priority);
}

/** The facts `pp plan` needs, gathered from the same helpers the other commands use. */

/**
 * `pp` with no arguments: the first screen.
 *
 * Three lines of fact and six commands. Deliberately *not* the 30-command list
 * (`pp help` has that): someone opening a terminal to find out what is going on
 * should not have to read a manual first. Local only — no ssh, so it is fast
 * enough to run out of habit.
 */
export function startSummary(facts) {
  const { version, configPath, sessions, nodes, running, off, stopped, unmanaged, cronJobs, cronLate } = facts;
  const where = configPath ?? "no config yet — pp init, then pp new <name> --save";
  const bits = [`${running}/${sessions} running`];
  if (nodes) bits.push(`${nodes} machine${nodes === 1 ? "" : "s"}`);
  if (cronJobs) bits.push(`${cronJobs} cron job${cronJobs === 1 ? "" : "s"}`);
  const trouble = [];
  if (off) trouble.push(`${off} off`);
  if (stopped) trouble.push(`${stopped} stopped by hand`);
  if (unmanaged) trouble.push(`${unmanaged} unmanaged`);
  if (cronLate) trouble.push(`${cronLate} cron behind`);
  // a config with nothing in it is not "nothing needs you right now": the next
  // thing to do is write the first session down
  const empty = sessions === 0 && Boolean(configPath);
  return {
    head: `pi-plus ${version} · ${where}`,
    facts: bits.join(" · "),
    verdict: empty
      ? "no sessions yet — pp new <name> [-C <dir>] --save, or uncomment the example in the config"
      : trouble.length
        ? `${trouble.join(" · ")} — pp plan orders them`
        : "nothing needs you right now",
  };
}

const START_COMMANDS = [
  ["pp tui", "the panel: what is running, enter a session, come back"],
  ["pp status", "the table (--json for scripts, --watch to watch it)"],
  ["pp plan", "what to do next, in the order that unblocks the most"],
  ["pp send", "put one line in front of an agent"],
  ["pp logs -f", "watch a session's output"],
  ["pp handover", "end of shift: what changed, what is off, what needs a human"],
  ["pp why <name>", "why is this one like this"],
  ["pp runbook", "an incident happened: work it in order"],
  ["pp help", "every command"],
];

async function cmdStart(options, ui) {
  let config = null;
  try {
    config = loadConfig({ configPath: options.config, cwd: options.cwd });
  } catch (error) {
    ui.error(error.message);
    process.exit(2);
  }
  const facts = {
    version: options.version ?? ownVersion(),
    configPath: config?.path ?? null,
    sessions: config?.sessions?.length ?? 0,
    nodes: config?.nodes?.length ?? 0,
    running: 0,
    off: 0,
    stopped: 0,
    unmanaged: 0,
    cronJobs: 0,
    cronLate: 0,
  };
  if (config) {
    try {
      const tmux = makeTmux(config, options);
      const live = tmux.listSessions();
      const mine = new Set(config.sessions.filter((session) => !session.node).map((session) => session.tmuxName));
      for (const session of config.sessions.filter((entry) => !entry.node)) {
        if (live.has(session.tmuxName)) facts.running += 1;
        else if (isStopped(config.path, session.name)) facts.stopped += 1;
        else if (session.restart !== "no" && !drainOf(config, session)) facts.off += 1;
      }
      for (const name of live.keys()) if (!mine.has(name)) facts.unmanaged += 1;
    } catch {
      facts.off = config.sessions.filter((session) => !session.node && session.restart !== "no").length;
    }
    const jobs = readJobs();
    facts.cronJobs = jobs.filter((job) => !job.done).length;
    facts.cronLate = overdueJobs(jobs, new Date()).length;
  }
  const summary = startSummary(facts);
  if (ui.json) {
    process.stdout.write(`${JSON.stringify({ ...summary, ...facts }, null, 2)}\n`);
    return;
  }
  ui.out(`${ui.paint("bold", summary.head)}`);
  ui.out(summary.facts);
  ui.out(summary.verdict === "nothing needs you right now" ? ui.paint("dim", summary.verdict) : ui.paint("yellow", summary.verdict));
  ui.out("");
  for (const [line, what] of START_COMMANDS) {
    ui.out(`  ${line.padEnd(14)} ${ui.paint("dim", what)}`);
  }
}


/** `pp runbook [scenario] [--markdown] [--json]`: the incident table, one scenario at a time. */
// one page a shift can be handed over with: what changed, what is wrong now,
// and what a human still has to decide

/**
 * `pp fleet` -- one table for every machine, asked live.
 *
 * Nothing is cached and nothing is written: the point is "what is running right
 * now", and a stale copy of that answer is worse than no answer.
 */
export /**
 * Pull what every machine is running, and keep it in the cache `pp ls` reads.
 *
 * Pull, not push: the machines do not know each other and most of them have no
 * pp at all — only this one has the ssh config and the credentials. A push
 * design would need pp and a peer list on every node, and would still leave the
 * question "which copy is true". One puller, one answer, one clock.
 */
async function cmdSync(config, options, ui) {
  const nodes = config.nodes ?? [];
  if (!nodes.length) {
    ui.info("no nodes in this config — nothing to sync");
    return;
  }
  const only = options.node ? resolveNodeRef(config, options.node) : null;
  if (options.node && !only) {
    ui.error(`no node "${options.node}" — see pp node ls`);
    process.exit(2);
  }
  const targets = only ? [only] : nodes;
  const started = Date.now();
  const rows = await Promise.all(
    targets.map(async (node) => {
      const at = Date.now();
      // one quoted command line: ssh joins argv with spaces, so each token has
      // to survive the far side's shell on its own
      const remote = ["tmux", ...(options.socket ? ["-L", String(options.socket)] : []), ...SESSION_QUERY]
        .map(shellQuote)
        .join(" ");
      const result = await runOnNodeAsync(node, [remote], { timeout: 15000 });
      const ms = Date.now() - at;
      if (result.error) return { node: node.name, ok: false, ms, error: result.error.message ?? "ssh failed", why: "unreachable" };
      const sessions = parseSessionLines(result.stdout);
      // tmux exits 1 for "no server" as well as for real trouble; the message is
      // the only difference, and a machine with no tmux running is an empty one
      const ok = result.status === 0 || /no server running|no sessions|error connecting to/i.test(String(result.stderr));
      const first = String(result.stderr ?? "").trim().split("\n")[0] || `exit ${result.status}`;
      // a machine without tmux answered us perfectly well — it just cannot
      // list sessions, and that is worth saying in those words
      const noTmux = /tmux: (command )?not found|tmux.*未找到命令|tmux: not found/i.test(first);
      // A machine without tmux is not broken: it simply does not run sessions.
      // Only machines that host sessions need tmux at all.
      if (noTmux) return { node: node.name, ok: true, ms, sessions: new Map(), tmux: false, error: null, why: null };
      return {
        node: node.name,
        ok,
        ms,
        sessions,
        tmux: true,
        error: ok ? null : first,
        why: ok ? null : "unreachable",
      };
    }),
  );
  const cache = readNodeCache();
  for (const row of rows) {
    if (!row.ok) continue;
    cache[row.node] = {
      at: new Date().toISOString(),
      tmux: row.tmux !== false,
      sessions: row.tmux === false ? {} : asCache(row.sessions),
    };
  }
  writeNodeCache(cache);
  if (options.json) {
    ui.out(JSON.stringify(rows.map((row) => ({ node: row.node, ok: row.ok, ms: row.ms, count: row.ok ? row.sessions.size : null, error: row.error ?? null })), null, 2));
  } else if (!options.quiet) {
    for (const row of rows) {
      const label = row.node.padEnd(Math.min(16, Math.max(...rows.map((entry) => entry.node.length)) + 1));
      if (!row.ok) ui.out(ui.paint("red", `  ${label}unreachable — ${row.error}`));
      else if (row.tmux === false) ui.out(ui.paint("dim", `  ${label}no tmux — nothing to list here`));
      else ui.out(`  ${label}${String(row.sessions.size).padStart(3)} session(s)  ${row.ms}ms`);
    }
    const bad = rows.filter((row) => !row.ok).length;
    const missing = rows.filter((row) => row.tmux === false).length;
    const parts = [];
    if (bad) parts.push(`${bad} unreachable (their last answer is kept)`);
    if (missing) parts.push(`${missing} without tmux (they do not run sessions)`);
    ui.out(
      `\n${rows.length}/${rows.length} machine(s) asked in ${Date.now() - started}ms${parts.length ? ` · ${parts.join(" · ")}` : ""}`,
    );
  }
  if (rows.some((row) => !row.ok)) process.exitCode = 1;
}

async function cmdFleet(config, options, ui) {
  const nodes = config?.nodes ?? [];
  const targets = [
    { label: "local", node: null, tmux: makeTmux(config, options) },
    // `{ node: name }`, not `{ node }`: nodeForSession looks the name up in
    // config.nodes, and an unknown shape quietly degrades to "local" -- which
    // is how a broken ssh once produced a fleet table identical to the local one.
    ...nodes.map((node) => ({ label: node.name, node, tmux: makeTmux(config, options, { node: node.name }) })),
  ];
  const results = await Promise.all(
    targets.map(async (entry) => {
      try {
        // listSessions is allowFailure: it answers "no session" both for an
        // empty machine and for an ssh that never connected. Ask separately,
        // otherwise an unreachable node silently shows up as an empty one.
        if (entry.node && !entry.tmux.reachable()) {
          return { ...entry, live: null, error: `cannot ssh to ${entry.label}` };
        }
        return { ...entry, live: entry.tmux.listSessions(), error: null };
      } catch (error) {
        return { ...entry, live: null, error: String(error.message ?? error) };
      }
    }),
  );
  const rows = [];
  for (const result of results) {
    if (!result.live) continue;
    for (const [name, info] of result.live) {
      rows.push({ name, node: result.node ? result.node.name : null, activity: info.activity ?? null });
    }
  }
  rows.sort((a, b) => compareNames(a.node ?? "", b.node ?? "") || compareNames(a.name, b.name));
  if (ui.json) {
    ui.out(
      JSON.stringify(
        {
          machines: results.map((result) => ({
            node: result.node ? result.node.name : null,
            reachable: !result.error,
            error: result.error,
            sessions: result.live ? [...result.live.keys()] : [],
          })),
          sessions: rows,
        },
        null,
        2,
      ),
    );
    return;
  }
  if (!rows.length) {
    const broken = results.filter((result) => result.error);
    if (broken.length) ui.warn(`no session could be listed — ${broken.map((r) => `${r.label}: ${r.error.split("\n")[0]}`).join("; ")}`);
    else ui.info("no tmux session is running anywhere");
    return;
  }
  // a machine can belong to one place ("work" vs "mine"); when it does, say so
  const groupOf = new Map(nodes.map((node) => [node.name, node.group ?? ""]));
  const showGroup = nodes.some((node) => node.group);
  const headers = ["SESSION", "NODE", ...(showGroup ? ["GROUP"] : []), "IDLE"];
  const table = rows.map((row) => [
    row.name,
    row.node ?? "local",
    ...(showGroup ? [groupOf.get(row.node) || "-"] : []),
    shortAge(row.activity ? Math.max(0, Math.round(Date.now() / 1000) - Number(row.activity)) : null),
  ]);
  const widths = headers.map((header, index) => Math.max(header.length, ...table.map((row) => displayWidth(row[index]))));
  const pad = (value, width) => value + " ".repeat(Math.max(0, width - displayWidth(value)));
  ui.out(ui.paint("bold", headers.map((header, index) => pad(header, widths[index])).join("  ").trimEnd()));
  table.forEach((row, index) => {
    const cells = [...row];
    cells[1] = ui.paint(cells[1] === "local" ? "dim" : "cyan", cells[1]);
    if (showGroup) cells[2] = ui.paint("magenta", cells[2]);
    cells[cells.length - 1] = ui.paint("dim", cells[cells.length - 1]);
    ui.out(cells.map((cell, i) => pad(cell, widths[i])).join("  ").trimEnd());
  });
  if (showGroup) {
    const perGroup = new Map();
    for (const node of nodes) {
      const key = node.group || "(no group)";
      perGroup.set(key, (perGroup.get(key) ?? 0) + 1);
    }
    ui.out(ui.paint("dim", `${[...perGroup.entries()].map(([key, count]) => `${key} ${count}`).join(" · ")} machines by group`));
  }
  const unreachable = results.filter((result) => result.error).map((result) => result.label);
  const machines = results.filter((result) => !result.error).length;
  ui.out(
    `\n${rows.length} session${rows.length === 1 ? "" : "s"} on ${machines} machine${machines === 1 ? "" : "s"}` +
      (unreachable.length ? ui.paint("red", `  · unreachable: ${unreachable.join(", ")}`) : ""),
  );
}

/**
 * `pp rename old new` -- one name change, done everywhere it is written down.
 *
 * The tmux session and the config entry have to move together: renaming only
 * one of them leaves a session that pp can see but not find. On a node the
 * rename is done *there* (its pp owns that config), with a plain tmux rename as
 * the fallback for a node that has an older pp or none at all.
 */
export async function cmdRename(config, options, ui) {
  const [oldRef, newName] = options.names;
  if (!oldRef || !newName) {
    ui.error("usage: pp rename <name|#> <new-name>");
    process.exit(2);
  }
  if (!NAME_RE.test(newName)) {
    ui.error(`"${newName}" is not a usable session name (letters, digits, - and _)`);
    process.exit(2);
  }
  const session = resolveSessionRef(config, oldRef);
  if (!session) {
    ui.error(`no session "${oldRef}" — see pp status`);
    process.exit(2);
  }
  if (newName === session.name) {
    ui.error(`${session.name} is already called that`);
    process.exit(2);
  }
  const taken = config.sessions.some((entry) => entry.name === newName || entry.tmuxName === newName);
  if (taken) {
    ui.error(`"${newName}" is taken — pick another name`);
    process.exit(2);
  }
  const handle = makeTmux(config, options, session);
  const node = nodeForSession(config, session);
  const target = `=${session.tmuxName}`;
  if (options.dryRun) {
    const where = node ? `ssh ${node.name} ` : "";
    ui.info(`[dry-run] ${where}tmux rename-session -t ${target} ${newName}`);
    ui.info(`[dry-run] ${config.path}: name ${session.name} -> ${newName}`);
    return;
  }

  let renamed = false;
  if (node) {
    // The node's own pp knows where its config lives; ask it first.
    const attempt = spawnSync("ssh", sshInvocation(node, ["pp", "rename", session.tmuxName, newName], { batch: true }).argv.slice(1), {
      encoding: "utf8",
    });
    renamed = attempt.status === 0;
    if (!renamed && options.verbose) ui.info(`node pp could not rename it (${(attempt.stderr || "").trim().split("\n")[0] || `exit ${attempt.status}`}) — renaming the tmux session only`);
  }
  if (!renamed) {
    try {
      handle.run(["rename-session", "-t", target, newName]);
      renamed = true;
    } catch (error) {
      if (!/can't find session|no such session/i.test(String(error.message))) throw error;
    }
  }

  const file = renameSessionInFile(config.path, session.name, newName);
  const todos = readTodos();
  let movedTodos = 0;
  for (const todo of todos) {
    if (todo.session === session.tmuxName || todo.session === session.name) {
      todo.session = newName;
      movedTodos += 1;
    }
  }
  if (movedTodos) writeTodos(todos);

  const jobs = readJobs();
  let movedJobs = 0;
  for (const job of jobs) {
    if (job.session === session.tmuxName || job.session === session.name) {
      job.session = newName;
      movedJobs += 1;
    }
  }
  if (movedJobs) writeJobs(jobs);

  note("rename", newName, { detail: `${session.name} -> ${newName}${file ? "" : " (no config entry)"}` });
  ui.info(`renamed ${session.name} → ${newName}${node ? ` on ${node.name}` : ""}`);
  if (!renamed) ui.warn(`${session.tmuxName} was not running — only the config was renamed`);
  if (file) ui.info(ui.paint("dim", `config: name${file.changed > 1 ? ", tmux_name" : ""} updated`));
  if (movedTodos) ui.info(ui.paint("dim", `${movedTodos} todo(s) now point at ${newName}`));
  if (movedJobs) ui.info(ui.paint("dim", `${movedJobs} cron job(s) now point at ${newName}`));
  if (session.piSession) ui.info(ui.paint("dim", `the conversation is unchanged: ${session.piSession}`));
  else ui.info(ui.paint("dim", `tip: pp bind ${newName} to pin its conversation`));
}


/** `pp plan [--json] [--nodes]`: what to do, in the order that unblocks the most. */

/**
 * `pp why <session>`: one screen that answers "why is it like this".
 *
 * Every fact it prints already exists in state.json, the config, tmux and the
 * cron file — the point is that an exhausted person at 3am should not have to
 * know where. Nothing here changes anything.
 */
// "why is everything with this label the way it is" — the same three-line
// answer per session, without asking you to walk the table row by row


function cmdLogs(config, options, ui) {
  const names = (options.names ?? []).filter((name) => name !== undefined);
  if (names.length === 0 && !options.all && !options.role) {
    ui.error("usage: pp logs <name...> [--lines N] [--follow]   (or --all, --role <label>)");
    process.exit(2);
  }
  // --all means all of them, including the ones whose restart policy says
  // "do not touch" — reading a pane is not touching it
  const sessions = options.all || (!names.length && options.role)
    ? selectSessions(config, [], ui, { all: true, options })
    : names.flatMap((name) => selectSessions(config, [name], ui, { options }));
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

async function cmdSend(config, options, ui) {
  // --all: one sentence into every session, the same fan-out pp cron uses.
  // Busy sessions are skipped on purpose: queueing a second prompt into an
  // agent that is mid-turn is how you get it to lose the thread.
  if (options.all || options.tags?.length || options.node || options.role) {
    if (options.names.length < 1) {
      ui.error('usage: pp send --all|--tag|--node|--role "text" [--dry-run]');
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
      // dry-run answers the question people actually have before broadcasting:
      // "who takes this, and who is busy enough to be skipped?"
      const plan = sessions.map((session) => {
        const tmux = makeTmux(config, options, session);
        let verdict = "send";
        let minutes = 0;
        try {
          if (!tmux.sessionExists(session.tmuxName)) verdict = "down";
          else if (tmux.isAgentBusy(session.tmuxName)) {
            verdict = "busy";
            minutes = stallWatch(config, tmux, session)?.busyMinutes ?? 0;
          }
        } catch {
          verdict = "unreachable";
        }
        return { session, tmux, verdict, minutes };
      });
      const tally = (kind) => plan.filter((row) => row.verdict === kind).length;
      ui.info(
        `[dry-run] ${sessions.length} target(s) — ${tally("send")} would take it, ${tally("busy")} busy, ${tally("down") + tally("unreachable")} not running${options.noEnter ? " (Enter will not be pressed)" : ""}`,
      );
      for (const row of plan) {
        if (row.verdict === "send") {
          const argv = options.verbose ? `  ${row.tmux.args(["send-keys", "-t", `=${row.session.tmuxName}:`, "--", text]).join(" ")}` : "";
          ui.out(`  ${ui.paint("green", "would send ")} ${row.session.tmuxName}${ui.paint("dim", argv)}`);
        } else if (row.verdict === "busy") {
          ui.out(`  ${ui.paint("yellow", "busy       ")} ${row.session.tmuxName}  ${ui.paint("dim", `mid-turn ${row.minutes ? shortAge(row.minutes * 60) : "just now"} — skipped, it would lose the thread`)}`);
        } else {
          ui.out(`  ${ui.paint("dim", `${row.verdict.padEnd(11)}`)} ${row.session.tmuxName}`);
        }
      }
      ui.out(ui.paint("dim", `\n  text: ${text.slice(0, 100)}${text.length > 100 ? "…" : ""}`));
      ui.out(ui.paint("dim", "  nothing was typed; drop --dry-run to send"));
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
  const linesAsked = Number(options.lines ?? 40) || 40;
  // Capture before typing: with --until-idle the caller wants the turn's output,
  // not the whole pane, and the pane's previous content is the noise to subtract.
  // The window reaches into scrollback, because a whole turn replaces the visible
  // screen — diffing 24 visible lines says "everything changed" and shows nothing.
  const scanLines = Math.max(linesAsked, 200);
  const result = tmux.sendText(session.tmuxName, text, { enter: !options.noEnter });
  note("send", session.name, { node: session.node ?? null, detail: text.length > 120 ? `${text.slice(0, 117)}…` : text, result: options.noEnter ? "typed" : "sent" });
  if (options.noEnter) {
    ui.info(`typed into ${session.name} (Enter not pressed)`);
    return;
  }
  if (!result.submitted) {
    ui.error(`${session.name}: the text is in the box but Enter never took it — look: pp logs ${session.name}`);
    process.exitCode = 1;
    return;
  }
  if (!options.untilIdle) {
    ui.info(`sent to ${session.name}`);
    return;
  }

  // --until-idle turns one line into a blocking call: useful for "do this, then
  // show me what it said", which is otherwise send + logs -f + eyeballs.
  const limit = Math.max(5, Number(options.timeout ?? 600) || 600);
  ui.info(`sent to ${session.name} — waiting up to ${limit}s for it to finish`);
  const waited = waitTillIdle(tmux, session.tmuxName, { limit, lines: scanLines });
  if (waited.reason === "exited") {
    ui.error(`${session.name} exited while waiting`);
    process.exitCode = 1;
    return;
  }
  if (waited.reason === "timeout") {
    ui.error(`${session.name} is still working after ${limit}s — watch it with: pp logs ${session.name} -f`);
    process.exitCode = 1;
    return;
  }
  ui.out(trimPane(String(waited.text ?? ""), text, linesAsked).join("\n"));
}

/**
 * The part of a captured pane that is worth showing a caller.
 *
 * A turn replaces the whole visible screen and pi runs in the alternate screen,
 * so there is no scrollback to diff against (tmux returns the visible screen
 * only). What can be removed reliably is the furniture: the input box at the
 * bottom (everything from its rules down), the echo of the line we just sent,
 * and trailing blank lines.
 */
export function trimPane(screen, sent, keep = 0) {
  const lines = String(screen).split("\n").map((line) => line.replace(/\s+$/u, ""));
  const rules = lines.map((line, index) => (isRule(line) ? index : -1)).filter((index) => index >= 0);
  const cut = rules.length >= 2 ? rules[rules.length - 2] : lines.length;
  const sentLines = new Set(String(sent ?? "").split("\n").map((line) => line.trim()).filter(Boolean));
  const kept = lines.slice(0, cut).filter((line) => !sentLines.has(line.trim()));
  while (kept.length && kept[kept.length - 1].trim() === "") kept.pop();
  return keep > 0 ? kept.slice(-keep) : kept;
}

/**
 * Block until an agent stops working, then hand back its screen.
 *
 * "Send a line, wait for the turn to end, print what it said" is the one loop
 * every operator writes by hand (send + logs -f + squinting). Returns instead of
 * printing so the waiting logic can be tested without a live agent.
 */
export function waitTillIdle(tmux, name, { limit = 600, lines = 40, sleep: pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms), now = () => Date.now(), pollMs = 1000 } = {}) {
  const started = now();
  for (;;) {
    if (!tmux.sessionExists(name)) return { ok: false, reason: "exited", text: null };
    if (!tmux.isAgentBusy(name)) {
      return { ok: true, reason: "idle", text: tmux.capture(name, Number(lines) || 40) };
    }
    if (now() - started >= limit * 1000) return { ok: false, reason: "timeout", text: null };
    pause(pollMs);
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
    return { name: session.name, busy: false, quiet: 0, doing: lastActionLine(text) };
  }
  const sinceBusy = busySinceOf(config.path, session.name, env) ?? markBusy(config.path, session.name, env, new Date(now).toISOString());
  // the spinner animates forever; only a change in content counts as progress
  const signature = contentSignature(text);
  const previous = activityOf(config.path, session.name, env);
  if (!previous || previous.sig !== signature) {
    noteActivity(config.path, session.name, { at: new Date(now).toISOString(), sig: signature }, env);
    return {
      name: session.name,
      busy: true,
      quiet: 0,
      busyMinutes: Math.round((now - Date.parse(sinceBusy)) / 60000),
      doing: lastActionLine(text),
    };
  }
  return {
    name: session.name,
    busy: true,
    quiet: Math.max(0, Math.round((now - Date.parse(previous.at)) / 60000)),
    busyMinutes: Math.round((now - Date.parse(sinceBusy)) / 60000),
    doing: lastActionLine(text),
  };
}

/**
 * "Which of these are actually working right now, and on what?" — the question
 * that `pp status` answers with nine rows of state, and `pp logs` answers one
 * session at a time. Costs one capture per running session.
 */
export async function cmdBusy(config, options, ui) {
  const rows = [];
  // one reachability probe per machine, not per session on it
  const reach = new Map();
  const reachable = (handle, node) => {
    if (!node) return true;
    if (!reach.has(node)) {
      let ok = true;
      try {
        ok = handle.reachable();
      } catch {
        ok = false;
      }
      reach.set(node, ok);
    }
    return reach.get(node);
  };
  for (const session of config.sessions) {
    const handle = makeTmux(config, options, session);
    if (!reachable(handle, session.node)) {
      rows.push({
        name: session.name,
        node: session.node,
        state: "unreachable",
        reason: `ssh to ${session.node} did not answer — pp node test ${session.node}`,
        busy: false,
        quiet: 0,
      });
      continue;
    }
    let running = false;
    try {
      running = handle.sessionExists(session.tmuxName);
    } catch (err) {
      rows.push({
        name: session.name,
        node: session.node,
        state: "unreachable",
        reason: String(err.message ?? err).split("\n")[0],
        busy: false,
        quiet: 0,
      });
      continue;
    }
    if (!running) {
      rows.push({ name: session.name, node: session.node, state: "off", busy: false, quiet: 0 });
      continue;
    }
    const reading = stallWatch(config, handle, session);
    rows.push({
      name: session.name,
      node: session.node,
      state: reading?.busy ? "working" : "idle",
      busy: Boolean(reading?.busy),
      quiet: reading?.quiet ?? 0,
      busyMinutes: reading?.busyMinutes ?? 0,
      doing: reading?.doing ?? "",
    });
  }
  rows.sort((a, b) => {
    if (a.busy !== b.busy) return a.busy ? -1 : 1;
    if (a.busy && b.busy) return (b.busyMinutes ?? 0) - (a.busyMinutes ?? 0) || compareNames(a.name, b.name);
    return compareNames(a.name, b.name);
  });
  if (ui.json) {
    process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
    return;
  }
  const working = rows.filter((row) => row.busy);
  if (!rows.length) {
    ui.out("no sessions configured — pp new or pp init");
    return;
  }
  const cells = (row) => ({
    session: row.name,
    node: row.node ?? "-",
    busy: row.busy ? shortAge((row.busyMinutes ?? 0) * 60) : "-",
    quiet: row.busy ? shortAge(row.quiet * 60) : "-",
  });
  const widths = [4, 4, 4, 5];
  for (const label of ["SESSION", "NODE", "BUSY", "QUIET"]) widths[["SESSION", "NODE", "BUSY", "QUIET"].indexOf(label)] = displayWidth(label);
  for (const row of rows) {
    const cell = cells(row);
    widths[0] = Math.max(widths[0], displayWidth(cell.session));
    widths[1] = Math.max(widths[1], displayWidth(cell.node));
    widths[2] = Math.max(widths[2], displayWidth(cell.busy));
    widths[3] = Math.max(widths[3], displayWidth(cell.quiet));
  }
  const pad = (text, width) => `${text}${" ".repeat(Math.max(0, width - displayWidth(text)))} `;
  ui.out(
    [pad("SESSION", widths[0]), pad("NODE", widths[1]), pad("BUSY", widths[2]), pad("QUIET", widths[3]), "DOING"].join(""),
  );
  for (const row of rows) {
    const cell = cells(row);
    const tail =
      row.state === "unreachable"
        ? ui.paint("red", `unreachable — ${row.reason}`)
        : row.busy
          ? row.doing || ui.paint("dim", "(nothing printed yet)")
          : ui.paint("dim", "idle — nothing is running");
    const busy = row.busy ? ui.paint("yellow", cell.busy) : cell.busy;
    ui.out([pad(cell.session, widths[0]), pad(cell.node, widths[1]), pad(busy, widths[2]), pad(cell.quiet, widths[3]), tail].join(""));
  }
  const limit = stallMinutes();
  const stuck = working.filter((row) => row.quiet * 60 >= limit);
  ui.out("");
  if (!working.length) {
    ui.info(`nothing is working — ${rows.length} session(s) idle or off`);
  } else if (stuck.length) {
    ui.warn(
      `${stuck.length} of ${working.length} working session(s) have printed nothing for ${Math.round(limit / 60)}m or more — look: pp logs ${stuck[0].name}`,
    );
  } else {
    ui.info(`${working.length} working, ${rows.length - working.length} idle or off — pp logs <name> for the full pane`);
  }
}

/** How long a `--command` job may run before the tick kills it. */
export const COMMAND_TIMEOUT_SECONDS = 300;

/** The first line of some output, clipped — for a status that has to stay one row. */
export function firstLine(text, limit = 120) {
  const line = String(text ?? "")
    .split("\n")
    .map((part) => part.trim())
    .find((part) => part);
  if (!line) return "";
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
}

const CLEAN_KEEP_BYTES = 2 * 1024 * 1024;
const LOG_WARN_BYTES = 50 * 1024 * 1024;

/** "512k", "2m", "1g", "1048576" -> bytes. No unit means bytes. */

export function humanBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  return `${(value / 1024 ** 3).toFixed(1)} GB`;
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
          problems.push(`"${session.name}": agent "${session.agent[0]}" not found on PATH — install it, or set agent: in the config`);
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
        notes.push(`"${session.name}": restart: no, so a bare "pp up" skips it — pp up ${session.name}`);
      } else if (isStopped(config.path, session.name)) {
        notes.push(`"${session.name}": stopped by hand (restart: ${session.restart}), autostart will skip it — pp up ${session.name}`);
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

  // Labels are free text typed by hand into a YAML file, and `prod` vs `Prod`
  // is two labels as far as every filter is concerned — the mistake is invisible
  // until a fan-out quietly reaches only half the sessions.
  const spellings = new Map();
  for (const session of config.sessions) {
    if (!session.role) continue;
    const key = session.role.toLowerCase();
    const list = spellings.get(key) ?? new Map();
    list.set(session.role, [...(list.get(session.role) ?? []), session.name]);
    spellings.set(key, list);
  }
  for (const [, list] of spellings) {
    if (list.size < 2) continue;
    const parts = [...list].map(([spelling, names]) => `"${spelling}" (${names.join(", ")})`);
    problems.push(`roles ${parts.join(" and ")} differ only by case — pick one: pp role <name> <label>`);
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
    return `${installed.version} but this cli is ${own} — npm install --prefix ${extensionPrefix(installed.dir)} pi-farm@${own} --registry https://registry.npmjs.org/`;
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

/**
 * `pp doctor --quarantine`: move the unreadable state files aside.
 *
 * Deleting them would be simpler and worse — the whole point of a broken file
 * is that it may still hold the evidence (which sessions were stopped by hand,
 * which jobs are due). rename keeps it readable while the next write starts
 * clean.
 */
function doctorQuarantine(ui, options) {
  const broken = inspectStateFiles(process.env).filter((entry) => !entry.ok);
  if (!broken.length) {
    ui.out("nothing to quarantine — every state file parses");
    return;
  }
  const moved = [];
  for (const entry of broken) {
    try {
      const target = quarantineStateFile(entry.path, process.env);
      if (target) moved.push({ file: entry.file, target });
    } catch (error) {
      ui.error(`could not move ${entry.file}: ${error.message}`);
      process.exitCode = 1;
    }
  }
  if (ui.json) {
    process.stdout.write(`${JSON.stringify(moved, null, 2)}\n`);
    return;
  }
  for (const entry of moved) ui.out(`moved ${ui.paint("bold", entry.file)} → ${entry.target}`);
  ui.out(ui.paint("dim", `${moved.length} file(s) kept as .broken-*; pp will write fresh ones`));
}

function cmdDoctor(config, options, ui) {
  // the machine park, not this machine: a different question, a different table
  if (options.nodes) return doctorNodes(config, options, ui);
  if (options.quarantine) return doctorQuarantine(ui, options);
  let tmux = null;
  try {
    tmux = makeTmux(config, options);
  } catch (error) {
    // doctor has to survive the thing it diagnoses: on a machine without tmux
    // this used to exit 1 with "tmux is not installed" and no table at all
    ui.info(`note: ${error.message}`);
  }
  const checks = [];
  // `fix` is the command that makes the check pass: at 3am "what do I type" beats
  // "what is wrong", and `--brief` is built out of these.
  const add = (label, ok, detail, fix = null) => checks.push({ label, ok, detail, fix });

  add("node", true, process.version);
  const tmuxVersion = (() => {
    if (!tmux) return null;
    try {
      return tmux.run(["-V"], { readOnly: true }).stdout.trim();
    } catch {
      return null;
    }
  })();
  add("tmux", Boolean(tmuxVersion), tmuxVersion ?? "not found", "install tmux (apt install tmux)");
  // everything below that would ask tmux something is gated on this: a missing
  // binary is a check on the table, not a reason to stop printing it
  const tmuxUsable = Boolean(tmuxVersion);
  const hasServer = tmuxUsable ? (() => { try { return tmux.hasServer(); } catch { return false; } })() : false;
  // A missing server is normal (tmux starts on demand) — not a failure.
  add("tmux server", true, hasServer ? "running" : "not running (starts on demand)");
  const piFound = commandExists("pi");
  add("pi", piFound, piFound ? resolveExecutable("pi") : "not on PATH", "npm i -g @earendil-works/pi-coding-agent");
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
    let tickBroken = null;
    try {
      const health = crondTickHealth(readCrontab());
      ticked = health.installed;
      // "the block is there" is not the same as "the block works": the tick line
      // holds absolute paths, and an nvm upgrade leaves it calling a file that
      // is gone — from the outside that looks exactly like a healthy schedule.
      if (health.installed && !health.ok) tickBroken = health;
    } catch {
      ticked = false;
    }
    const lastTick = jobs.reduce((newest, job) => Math.max(newest, Date.parse(job.lastRun ?? "") || 0), 0);
    const ageMinutes = lastTick ? Math.round((Date.now() - lastTick) / 60000) : null;
    const overdue = overdueJobs(jobs);
    const dangling = config
      ? [
          ...danglingRoleJobs(jobs, config).map((job) => ({ job, missing: `role "${job.role}"`, hint: `pp cron retarget ${job.id} --role <label>` })),
          ...danglingSessionJobs(jobs, config).map((job) => ({ job, missing: `session "${job.session}"`, hint: `pp cron retarget ${job.id} --session <name>` })),
        ]
      : [];
    const detail = tickBroken
      ? `the tick cannot run — ${tickBroken.problems[0]} — pp install rewrites it`
      : !jobs.length
      ? "no jobs — pp cron add --every 10m \"…\""
      : dangling.length
        ? `${dangling[0].job.id} targets ${dangling[0].missing} — nothing carries it (${dangling[0].hint})` +
          (dangling.length > 1 ? ` (+${dangling.length - 1} more)` : "")
        : overdue.length
          ? `${overdue[0].id} is ${overdue[0].late} late — pp cron run ${overdue[0].id}` +
            (overdue.length > 1 ? ` (+${overdue.length - 1} more)` : "")
          : `${jobs.length} job${jobs.length === 1 ? "" : "s"}, tick ${ticked ? "installed" : "not installed"}` +
            (ageMinutes === null ? "" : `, last fired ${ageMinutes}m ago`);
    const healthy =
      !tickBroken &&
      (!jobs.length ||
        (ticked && (ageMinutes === null || ageMinutes < 60) && overdue.length === 0 && dangling.length === 0));
    // a job aimed at a label nobody carries is the quietest possible failure:
    // it ticks, it succeeds, it reaches nobody
    add(
      "cron",
      healthy,
      detail,
      dangling.length ? (dangling[0].hint ?? `pp cron ls`) : overdue.length ? `pp cron run ${overdue[0].id}` : "pp install",
    );
    // orientation, not a verdict: where the last copy is and how old
    const backups = listBackups(backupDir(process.env));
    const newest = backups[backups.length - 1];
    const newestAt = newest ? describeBackup(newest.path).at : null;
    // a backup nobody has opened in a month is a hope, not a copy: check the
    // newest one is still whole before calling this "fine"
    const intact = newest ? verifyBackup(newest.path) : null;
    add(
      "backup",
      !intact || intact.ok,
      !newest
        ? "none yet — pp backup before you edit the config"
        : intact && !intact.ok
          ? `${newest.name}: ${intact.problems[0]} — pp backup`
          : `last ${newestAt ? agoText(newestAt, new Date()) : newest.name} — ${newest.name}, ${intact?.files.length ?? 0} file(s), intact`,
      "pp backup",
    );
  }
  // A full disk is the failure where everything else starts lying: writes fail
  // silently, pi stops answering, and every other check looks fine.
  {
    const free = freeSpace(stateDir(process.env));
    if (free) {
      const enough = free.bytes >= diskFloorBytes(process.env);
      add(
        "disk",
        enough,
        `${humanBytes(free.bytes)} free on ${free.mount} — ${enough ? "enough" : `pp clean · pp snapshot --prune (wants ${humanBytes(diskFloorBytes(process.env))})`}`,
        "pp clean",
      );
    }
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
    const live = tmuxUsable ? (() => { try { return tmux.listSessions(); } catch { return new Map(); } })() : new Map();
    const local = config.sessions.filter((session) => !session.node);
    const mine = new Set(local.map((session) => session.tmuxName));
    const parked = local.filter((session) => !live.has(session.tmuxName) && session.restart !== "no").map((session) => session.name);
    const strays = [...live.keys()].filter((name) => !mine.has(name));
    if (!tmuxUsable) {
      // without tmux nothing can be running; the `tmux` check above already says why
      add("drift", true, "not checked (tmux is missing)");
    } else add(
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
    const live = tmuxUsable ? (() => { try { return tmux.listSessions(); } catch { return new Map(); } })() : new Map();
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
    // a `log:` session whose pipe died looks configured and has no new lines:
    // "we have the logs" is exactly the wrong assumption to hold at 3am
    const deadPipes = [];
    let logging = 0;
    for (const session of config.sessions.filter((entry) => entry.log && !entry.node)) {
      try {
        const state = tmux.paneState(session.tmuxName);
        if (state.exists && !state.dead) logging += 1;
        if (state.exists && !state.dead && !state.pipe) deadPipes.push(session.name);
      } catch {
        // an unreachable pane is not this check's business
      }
    }
    // `--name` labels a conversation; only `--session-id` reopens one. Without
    // it every restart starts a fresh conversation under the same name.
    const unbound = config.sessions.filter((entry) => entry.pi && !entry.piSession);
    add(
      "pi sessions",
      unbound.length === 0,
      unbound.length
        ? `${unbound.length} session(s) start a new conversation on every restart (${unbound
            .slice(0, 3)
            .map((entry) => entry.name)
            .join(", ")}${unbound.length > 3 ? `, +${unbound.length - 3}` : ""}) — pp bind ${unbound[0].name}`
        : config.sessions.some((entry) => entry.pi)
          ? `every pi session is pinned to one conversation`
          : "no session runs pi",
      `pp bind ${unbound[0]?.name ?? "<name>"}`,
    );
    add(
      "pipes",
      deadPipes.length === 0,
      deadPipes.length
        ? `${deadPipes.map((name) => `${name} has log: but nothing is writing`).join(", ")} — pp restart ${deadPipes[0]}`
        : config.sessions.some((entry) => entry.log)
          ? logging
            ? `every log: session is still piping (${logging} of them)`
            : "no log: session is running right now (nothing to check)"
          : "no session asks for log: (nothing to check)",
      deadPipes.length ? `pp restart ${deadPipes[0]}` : null,
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
  // pp's own files: every reader here swallows a parse error on purpose (a
  // corrupt state.json must not block `pp up` at 3am), but swallowing it
  // silently means the work you did quietly disappears — so say it out loud
  const stateFiles = inspectStateFiles(process.env);
  const brokenFiles = stateFiles.filter((entry) => !entry.ok);
  add(
    "own files",
    brokenFiles.length === 0,
    describeStateFiles(stateFiles, process.env),
    brokenFiles.length ? "pp doctor --quarantine" : null,
  );
  const autostart = autostartState();
  add(
    "autostart",
    Boolean(autostart.kind) && autostart.installed && autostart.enabled && autostart.health?.ok !== false,
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
    "disk",
    "node",
    "tmux",
    "pi",
    "command name",
    "pi extension",
    "autostart",
    "cron",
    "own files",
    "drift",
    "logs",
    "pi sessions",
    "pipes",
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

/**
 * `--prefix` wants the directory whose `node_modules` holds the package, not
 * the package directory itself. `…/npm/node_modules/pi-farm` → `…/npm`.
 */
export function extensionPrefix(dir) {
  const parts = String(dir ?? "").split("/");
  if (parts.length < 3) return String(dir ?? "");
  if (parts[parts.length - 2] === "node_modules") return parts.slice(0, -2).join("/") || "/";
  return parts.slice(0, -1).join("/") || "/";
}

/**
 * The one-liner that upgrades the pi extension, or null when it is current.
 *
 * `/pp-*` commands come from the extension, not from the cli, and npm never
 * upgrades it: `pp update` and `pp doctor` both have to say this out loud.
 */
export function extensionUpgradeHint(extension, own) {
  if (!extension || !own || !extension.version) return null;
  if (compareVersions(extension.version, own) >= 0) return null;
  return `npm install --prefix ${extensionPrefix(extension.dir)} pi-farm@${own} --registry https://registry.npmjs.org/`;
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
    const ext = installedExtension(process.env);
    ui.out(
      JSON.stringify(
        {
          current,
          latest,
          upToDate: !behind,
          installKind: info.kind,
          command: plan ? [plan.command, ...plan.args] : null,
          extension: ext ? { path: ext.dir, version: ext.version, upToDate: compareVersions(latest, ext.version) <= 0 } : null,
        },
        null,
        2,
      ),
    );
    process.exitCode = behind ? 1 : 0;
    return;
  }

  // The cli and the pi extension are two installs. "The cli is up to date" is
  // not the same as "everything is up to date": a stale extension is what makes
  // /pp-* commands look missing while the version on screen says otherwise.
  const extension = installedExtension(process.env);
  const extensionBehind = Boolean(extension) && compareVersions(latest, extension.version) > 0;
  const extensionLine = extension ? extensionUpgradeHint(extension, latest) : null;

  if (!behind) {
    if (!extensionBehind) {
      ui.info(`pi-farm ${current} is up to date (latest ${latest})`);
      return;
    }
    ui.warn(`the pi extension is still ${extension.version} — /pp-* commands come from it, not from the cli`);
    ui.info(`pi-farm ${current} is up to date (latest ${latest})`);
    if (options.check) {
      ui.info(ui.paint("dim", `would run: ${extensionLine}`));
      process.exitCode = 1;
      return;
    }
    if (options.dryRun) {
      ui.info(`[dry-run] ${extensionLine}`);
      return;
    }
    ui.info(ui.paint("dim", `$ ${extensionLine}`));
    const fixed = spawnSync("npm", extensionLine.replace(/^npm /, "").split(" "), { stdio: "inherit" });
    if (fixed.status === 0) {
      const after = installedExtension(process.env);
      ui.info(`extension now ${after?.version ?? "?"} — /reload inside pi to pick it up`);
      return;
    }
    ui.error("updating the extension failed; run the command above by hand");
    process.exitCode = fixed.status ?? 1;
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
  // Three independent facts, three independent sentences. These used to be one
  // if/else chain, which made "the copy is now 0.80.10" and "the copy is still
  // 0.80.10" print together -- a false alarm that reads like a real one.
  const upgraded = compareVersions(after, latest) >= 0;
  if (upgraded) ui.info(`now pi-farm ${after}`);
  else {
    ui.error(`npm finished but this copy is still ${after} (another pi-farm may shadow it: type -a pp)`);
    process.exitCode = 1;
  }
  if (result.status !== 0 && result.status !== null) process.exitCode = result.status;
  // the /pp-* commands live in the pi extension, which npm does not touch:
  // upgrading the cli alone leaves a stale extension behind (it has bitten us
  // twice — a command that "does not exist" although the version looked right)
  const nowExtension = installedExtension(process.env);
  const hint = extensionUpgradeHint(nowExtension, after);
  if (nowExtension && hint) {
    ui.warn(`the pi extension is still ${nowExtension.version} — /pp-* commands come from it, not from the cli`);
    ui.info(ui.paint("dim", `${hint}  (then /reload inside pi)`));
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

/**
 * Sessions carrying a role — the same two-way join `--role` does elsewhere, so
 * `pp cron add --role dev` means what `pp status --role dev` shows.
 */
export function roleTargets(config, role) {
  const wanted = String(role ?? "").trim().toLowerCase();
  if (!wanted) return [];
  return (config?.sessions ?? []).filter((session) => String(session.role ?? "").toLowerCase() === wanted);
}

/**
 * Jobs aimed at a label that no session carries.
 *
 * `pp cron add --role dev` is validated when it is created, but labels get
 * renamed and cleared later — and then the job ticks, reports `delivered`…
 * to nobody. Nothing else in pp would ever notice.
 */
export function danglingRoleJobs(jobs, config) {
  return (jobs ?? []).filter((job) => job.role && roleTargets(config, job.role).length === 0);
}

/**
 * Jobs aimed at a single session that the config no longer has: renaming or
 * deleting a session leaves them ticking at nothing, which looks like "the cron
 * is broken" from the outside. Role jobs and actions with no session are not
 * this problem and are not reported here.
 */
export function danglingSessionJobs(jobs, config) {
  if (!config) return [];
  const known = new Set();
  for (const session of config.sessions ?? []) {
    known.add(session.name);
    known.add(session.tmuxName);
  }
  return (jobs ?? []).filter(
    (job) =>
      job.session &&
      job.session !== ALL_SESSIONS &&
      !job.role &&
      job.action !== "command" &&
      job.action !== "heal" &&
      !known.has(job.session),
  );
}

/**
 * How long a tmux session has been quiet, in seconds — `activity` is the
 * window-activity stamp from `listSessions()` (epoch seconds, moves whenever the
 * pane prints anything). null when tmux cannot say, so a missing stamp never
 * looks like "quiet".
 */
export function quietSeconds(activity, nowMs = Date.now()) {
  const at = Number(activity);
  if (!Number.isFinite(at) || at <= 0) return null;
  return Math.max(0, Math.round((nowMs - at * 1000) / 1000));
}

/** Should a nudge skip this session because it moved less than `idleAfter` ago? */
export function tooFresh(activity, idleAfter, nowMs = Date.now()) {
  if (!idleAfter) return false;
  const quiet = quietSeconds(activity, nowMs);
  if (quiet === null) return false;
  return quiet < idleAfter;
}

function deliverToRole(job, options) {
  const config = loadConfig({ configPath: job.configPath ?? null, cwd: process.cwd() });
  if (!config) return { status: `skipped: no config to read the role from` };
  const targets = roleTargets(config, job.role);
  if (!targets.length) {
    const inUse = [...new Set(config.sessions.map((session) => session.role).filter(Boolean))];
    return {
      status: `skipped: no session has role "${job.role}"${inUse.length ? ` (roles in use: ${inUse.join(", ")})` : ""}`,
    };
  }
  const sent = [];
  const busy = [];
  const idle = [];
  const failed = [];
  const fresh = [];
  for (const session of targets) {
    const tmux = makeTmux(config, options, session);
    if (!tmux.sessionExists(session.tmuxName)) {
      idle.push(session.tmuxName);
      continue;
    }
    if (job.idleAfter) {
      let live = null;
      try {
        live = tmux.listSessions();
      } catch {
        live = null;
      }
      if (tooFresh(live?.get(session.tmuxName)?.activity, job.idleAfter)) {
        fresh.push(session.tmuxName);
        continue;
      }
    }
    if (tmux.isAgentBusy(session.tmuxName)) {
      busy.push(session.tmuxName);
      continue;
    }
    let result;
    try {
      result = tmux.sendText(session.tmuxName, job.prompt);
    } catch {
      failed.push(session.tmuxName);
      continue;
    }
    if (result.submitted) sent.push(session.tmuxName);
    else failed.push(session.tmuxName);
  }
  const parts = [
    sent.length ? `${sent.length} sent` : null,
    busy.length ? `${busy.length} busy` : null,
    fresh.length ? `${fresh.length} busy lately` : null,
    idle.length ? `${idle.length} not running` : null,
    failed.length ? `${failed.length} failed` : null,
  ].filter(Boolean);
  const tail = parts.join(", ");
  if (!sent.length && busy.length && !failed.length && !idle.length) {
    return { status: `deferred: every ${job.role} session is working — the next tick will deliver` };
  }
  if (!sent.length && !busy.length) {
    return { status: `skipped: no ${job.role} session is running (${tail || targets.length} targeted)` };
  }
  return { status: "delivered", text: `to ${sent.length}/${targets.length} ${job.role}, ${tail}` };
}
// heal: after this many restarts inside the window, stop and let a human look
const HEAL_LIMIT = 3;
const HEAL_WINDOW_MS = 60 * 60 * 1000;

/**
 * Fan a prompt out to every running session. Busy agents are skipped — pi parks
 * typed input in its editor and never submits it, so a busy pane would only
 * collect another copy (see `deliverJob`).
 */
/** The config a job points at, or null — jobs outlive config edits. */
function jobConfig(job) {
  if (!job.configPath) return null;
  try {
    return loadConfig({ configPath: job.configPath, cwd: process.cwd() });
  } catch {
    return null;
  }
}

/** A session that belongs to a drained machine, by job name or tmux name. */
function drainedTarget(config, name) {
  if (!config) return null;
  const session = (config.sessions ?? []).find((entry) => entry.name === name || entry.tmuxName === name);
  return session && drainOf(config, session) ? session : null;
}

function deliverToEverySession(tmux, job) {
  let live;
  try {
    live = tmux.listSessions();
  } catch {
    live = new Map();
  }
  const config = jobConfig(job);
  const drained = [...live.keys()].filter((name) => drainedTarget(config, name));
  const names = [...live.keys()].filter((name) => !drained.includes(name)).sort();
  if (names.length === 0) {
    return {
      status: drained.length
        ? `deferred: all ${drained.length} running session(s) are on drained machines — the next tick will deliver`
        : "skipped: no tmux session is running",
    };
  }
  const sent = [];
  const busy = [];
  const failed = [];
  const fresh = [];
  for (const name of names) {
    if (tooFresh(live.get(name)?.activity, job.idleAfter)) {
      fresh.push(name);
      continue;
    }
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
  if (sent.length === 0 && failed.length === 0 && fresh.length && !busy.length) {
    return { status: `deferred: every session moved within ${formatDuration(job.idleAfter)} — nothing to nudge yet` };
  }
  if (sent.length === 0 && failed.length === 0) {
    return { status: `deferred: all ${busy.length} sessions are working — the next tick will deliver` };
  }
  if (sent.length === 0) {
    return { status: `failed: none of ${names.length} sessions took the prompt (${failed.join(", ")})` };
  }
  const detail = [`${sent.length}/${names.length}`];
  if (busy.length) detail.push(`${busy.length} busy`);
  if (fresh.length) detail.push(`${fresh.length} busy lately`);
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

export function deliverJob(job, options) {
  if (job.action === "heal") return healDrift(job, options);
  if (job.action === "sweep") return sweepFleet(job, options);
  if (job.action === "command") {
    // A hung command would hold the tick lock forever and every other job would
    // quietly stop running — so a command job always has a deadline.
    const timeout = Number(job.timeout ?? COMMAND_TIMEOUT_SECONDS) * 1000;
    const started = Date.now();
    const result = spawnSync("sh", ["-c", job.command], {
      encoding: "utf8",
      timeout,
      killSignal: "SIGKILL",
    });
    const output = String(result.stderr ?? "").trim() || String(result.stdout ?? "").trim();
    if (result.error) {
      const why = result.error.code === "ETIMEDOUT" ? `timed out after ${Math.round(timeout / 1000)}s` : result.error.message;
      return { status: `failed: ${why}`, output };
    }
    if (result.status !== 0) {
      const took = Math.round((Date.now() - started) / 1000);
      const why = result.signal === "SIGKILL" && timeout && took * 1000 >= timeout * 0.9 ? `timed out after ${Math.round(timeout / 1000)}s` : `exit ${result.status}`;
      // "exit 3" alone sends you looking for the script; the first line of what
      // it said usually ends the search
      const gist = firstLine(output, 120);
      return { status: `failed: ${why}${gist ? ` — ${gist}` : ""}`, output };
    }
    return { status: "delivered", output };
  }

  if (job.role) return deliverToRole(job, options);
  // a drained machine is under maintenance: its sessions stay down on purpose,
  // so "session is not running" would be a nightly false alarm in the log
  const onDrained = drainedTarget(jobConfig(job), job.session);
  if (onDrained) {
    return {
      status: `deferred: ${job.session} is on a drained machine (${onDrained.node}) — pp node undrain ${onDrained.node}`,
    };
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
  // --idle-after: only nudge a session that has actually gone quiet
  if (job.idleAfter) {
    let live = null;
    try {
      live = tmux.listSessions();
    } catch {
      live = null;
    }
    if (tooFresh(live?.get(job.session)?.activity, job.idleAfter)) {
      return { status: `deferred: ${job.session} moved less than ${formatDuration(job.idleAfter)} ago — nothing to nudge yet` };
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
 * Sort names the way a person reads them: `risk-2` before `risk-10`, and
 * case/width differences do not scatter the same family across the list.
 */
/**
 * Set (or show, or clear) a session's role without editing the YAML by hand.
 *
 * The role is a label for people ("what is this one for?"), so it never changes
 * how pp schedules or heals anything.
 */

export function rolesInUse(config) {
  // what can go into --role: the labels actually written down, with how many
  // sessions carry each — `pp role --list` answers "what words do we use?".
  const counts = new Map();
  for (const session of config.sessions) {
    const role = session.role;
    if (!role) continue;
    const key = counts.get(role) ?? { role, sessions: [] };
    key.sessions.push(session.name);
    counts.set(role, key);
  }
  return [...counts.values()]
    .map((entry) => ({ ...entry, sessions: [...entry.sessions].sort(compareNames), count: entry.sessions.length }))
    .sort((a, b) => b.count - a.count || compareNames(a.role, b.role));
}

/** Conversations pi already has on disk for this machine/session, newest first. */
function bindCandidates(config, session) {
  if (!session.node) {
    return listPiSessions(session.cwd, process.env, { withNames: true }).sessions.map((entry) => ({ ...entry }));
  }
  const node = config.nodes.find((entry) => entry.name === session.node);
  if (!node) return [];
  const slug = session.cwd.replace(/^\/+/, "").replace(/\//g, "-");
  const script = [
    `d="$HOME/.pi/agent/sessions/--${slug}--"`,
    '[ -d "$d" ] || exit 0',
    'find "$d" -maxdepth 1 -name "*.jsonl" -printf "%T@|%s|%p\\n" 2>/dev/null | sort -rn | head -5 | while IFS="|" read -r mtime bytes path; do',
    "  id=$(head -c 400 \"$path\" | sed -n 's/.*\"id\":\"\([^\"]*\)\".*/\\1/p')",
    "  label=$(tail -c 400000 \"$path\" | grep -o '\"type\":\"session_info\"[^}]*\"name\":\"[^\"]*\"' | tail -1 | sed -n 's/.*\"name\":\"\([^\"]*\)\".*/\\1/p')",
    '  [ -n "$id" ] && echo "$id|$mtime|$bytes|$label"',
    'done',
  ].join("\n");
  const result = runOnNode(node, [script], { timeout: 20000 });
  if (result.error || result.status !== 0) return [];
  return String(result.stdout ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [id, mtime, bytes, label] = line.split("|");
      return { id, modified: Number(mtime) * 1000, bytes: Number(bytes), name: id, displayName: label || null };
    });
}

/**
 * Pin a session to one pi conversation.
 *
 * pi's `--name` only labels a session; without `--session-id` every start is a
 * fresh conversation that happens to carry the same name. Guessing the id from
 * "the newest file" is wrong whenever two agents share a directory, so there we
 * list the candidates and refuse until you pick one.
 */
export function cmdBind(config, options, ui) {
  const [ref] = options.names ?? [];
  if (!ref) {
    ui.error("give a session: pp bind <name|#> [--id <session-id>]");
    process.exitCode = 2;
    return;
  }
  const [session] = selectSessions(config, [ref], ui);
  if (!session) return;
  if (!session.pi) {
    ui.error(`${session.name} does not run pi — there is no pi conversation to pin`);
    process.exitCode = 2;
    return;
  }
  if (session.piSession) {
    ui.info(`${ui.paint("dim", session.name)} already uses ${ui.paint("bold", session.piSession)} — nothing to bind`);
    return;
  }
  const candidates = bindCandidates(config, session);
  const siblings = config.sessions.filter(
    (other) =>
      other.name !== session.name && other.pi && other.cwd === session.cwd && (other.node ?? null) === (session.node ?? null),
  );
  const describe = (entry) =>
    `  ${ui.paint("bold", entry.id)}  ${ui.paint("dim", `${ageOf(entry.modified)} · ${Math.round(entry.bytes / 1024)} KB`)}`;
  const want = options.id ?? null;
  if (!want) {
    if (!candidates.length) {
      ui.error(`no pi conversation for ${session.cwd} yet — start ${session.name} once, then bind`);
      process.exitCode = 1;
      return;
    }
    // A conversation records the name it was given (`session_info`), so when two
    // agents share a directory the name is what tells them apart. Several files
    // can carry the same name — that is the pile-up this command exists to stop,
    // and the one still being written is the newest.
    const label = session.piSessionName ?? session.name;
    const named = candidates.filter((entry) => entry.displayName === label);
    if (named.length) {
      const pick = named[0];
      if (options.dryRun) {
        ui.out(ui.paint("dim", `[dry-run] would write pi_session: ${pick.id} to ${config.path} (matched by name ${label})`));
        return;
      }
      auditedWrite({ config, action: "config.changed", target: session.name }, () =>
        setSessionFieldInFile(config.path, session.name, "pi_session", pick.id),
      );
      ui.info(
        `${ui.paint("bold", session.name)} → ${ui.paint("bold", pick.id)}${ui.paint("dim", `  (${ageOf(pick.modified)}, ${Math.round(pick.bytes / 1024)} KB, matched by name ${label})`)}`,
      );
      if (named.length > 1) {
        ui.info(
          ui.paint("dim", `${named.length - 1} older conversation(s) carry the same name — pick another: pp bind ${session.name} --id <id>`),
        );
      }
      ui.info(ui.paint("dim", `next restart returns to this conversation: pp restart ${session.name}`));
      return;
    }
    if (siblings.length) {
      ui.error(
        `${session.cwd} has more than one pi session (${siblings.map((other) => other.name).join(", ")}) — pick the id by hand`,
      );
      ui.info(ui.paint("dim", "the newest conversations in that directory:"));
      for (const entry of candidates.slice(0, 5)) ui.out(describe(entry));
      ui.info(ui.paint("dim", `then: pp bind ${session.name} --id <id>`));
      process.exitCode = 2;
      return;
    }
    if (candidates.length > 1) {
      ui.info(ui.paint("dim", `binding the newest of ${candidates.length} conversations:`));
      for (const entry of candidates.slice(0, 3)) ui.out(describe(entry));
    }
  }
  const id = want ?? candidates[0].id;
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(id)) {
    ui.error(`"${id}" is not a pi session id`);
    process.exitCode = 2;
    return;
  }
  const match = candidates.find((entry) => entry.id === id) ?? null;
  if (options.dryRun) {
    ui.out(ui.paint("dim", `[dry-run] would write pi_session: ${id} to ${config.path}`));
    return;
  }
  auditedWrite({ config, action: "config.changed", target: session.name }, () =>
    setSessionFieldInFile(config.path, session.name, "pi_session", id),
  );
  ui.info(
    `${ui.paint("bold", session.name)} → ${ui.paint("bold", id)}${
      match
        ? ui.paint("dim", `  (${ageOf(match.modified)}, ${Math.round(match.bytes / 1024)} KB)`)
        : ui.paint("dim", "  (no file for it yet — pi will create it)")
    }`,
  );
  ui.info(ui.paint("dim", `next restart returns to this conversation: pp restart ${session.name}`));
}


export function compareNames(a, b) {
  return String(a ?? "").localeCompare(String(b ?? ""), undefined, { numeric: true, sensitivity: "base" });
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
    // a hand-edited or half-written cron.json can hold a job with no schedule;
    // that must not take down `pp doctor` (it is the command you run when
    // something is wrong, so it has to survive wrong input)
    let due;
    try {
      due = nextRun(job, now);
    } catch {
      continue;
    }
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
  if (delta <= 0) return { text: `due now (${clock})`, late: delta < 0 };
  return { text: `in ${rough(delta)} (${clock})`, late: false };
}

/** How many times a job fires in a day — the honest denominator for cost. */
export function deliveriesPerDay(schedule, { now = new Date() } = {}) {
  if (!schedule) return 0;
  if (schedule.kind === "once") return 1;
  if (schedule.kind === "every") return Math.ceil(86400 / Math.max(1, schedule.every));
  if (schedule.kind === "cron") {
    // Ask the matcher over four weeks rather than doing the arithmetic by hand:
    // a daily window would report 0 for "Mondays only" and for monthly jobs.
    const parsed = parseCron(schedule.cron);
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    let hits = 0;
    const days = 28;
    for (let minute = 0; minute < days * 1440; minute += 1) {
      if (cronMatches(parsed, new Date(start.getTime() + minute * 60000))) hits += 1;
    }
    return Math.round((hits / days) * 100) / 100;
  }
  return 0;
}

/** How many sessions one delivery reaches. */
export function deliveryTargets(job, sessions = []) {
  if (job.action === "command" || job.action === "heal" || job.action === "sweep") return 1;
  if (job.role) return sessions.filter((session) => String(session.role ?? "").toLowerCase() === String(job.role).toLowerCase()).length;
  if (job.session === ALL_SESSIONS) return sessions.length;
  return job.session ? 1 : 0;
}

/** How long has this job been waiting for its target to free up? */
export function deferredFor(job, now = new Date()) {
  if (!job.deferredSince) return 0;
  const since = Date.parse(job.deferredSince);
  return Number.isNaN(since) ? 0 : Math.max(0, now.getTime() - since);
}

export function cronRow(job, now = new Date()) {
  const due = nextRun(job, now);
  const next = describeNext(due, now);
  // A deferred job keeps its due time on purpose (the next tick retries it), so
  // "late" would be the wrong word every minute until the target frees up.
  const deferred = String(job.lastStatus ?? "").startsWith("deferred:");
  const streak = deferredFor(job, now);
  const since = deferred && job.deferredSince
    ? `${String(new Date(job.deferredSince).getHours()).padStart(2, "0")}:${String(new Date(job.deferredSince).getMinutes()).padStart(2, "0")}`
    : null;
  const waiting = deferred
    ? since
      ? `waiting since ${since} (${shortAge(Math.round(streak / 1000))})`
      : next.late
        ? next.text.replace(/^late [^(]*\(/, "waiting (")
        : next.text
    : next.text;
  return {
    id: job.id,
    session: job.action === "command"
      ? `$ ${job.command}`
      : job.role
        ? `role ${job.role}`
        : job.session === ALL_SESSIONS
          ? "all sessions"
          : job.session,
    action: job.action,
    session: job.session ?? null,
    role: job.role ?? null,
    schedule: `${describeSchedule(job.schedule)}${job.idleAfter ? ` · idle ${formatDuration(job.idleAfter)}` : ""}${job.window ? ` · quiet ${describeWindow(job.window)}` : ""}${job.maxPerDay ? ` · max ${job.maxPerDay}/day` : ""}${job.timeout ? ` · ≤${job.timeout}s` : ""}`,
    next: waiting,
    late: deferred ? false : next.late,
    deferred,
    nextRun: due ? due.toISOString() : null,
    runs: job.runs ?? 0,
    last: job.lastStatus ?? "-",
    paused: Boolean(job.paused),
    idleAfter: job.idleAfter ?? null,
    maxPerDay: job.maxPerDay ?? null,
    dayRuns: dailyRuns(job, now),
    deferredSince: job.deferredSince ?? null,
    waitingFor: streak,
  };
}

export function printCronJobs(jobs, ui, now = new Date(), sessions = []) {
  if (!jobs.length) {
    ui.info("no scheduled jobs — add one with: pp cron add --at \"2026-11-21T09:00\" \"check the build\"");
    return;
  }
  const records = jobs.map((job) => cronRow(job, now));
  const headers = ["ID", "TARGET", "SCHEDULE", "NEXT", "RUNS", "LAST"];
  // Where a job points, and whether that address still exists: a renamed session
  // leaves a schedule that keeps reporting `delivered` to nobody.
  const byName = new Map();
  for (const session of sessions) {
    byName.set(session.name, session);
    if (session.tmuxName) byName.set(session.tmuxName, session);
  }
  const roleCount = (label) => sessions.filter((session) => String(session.role ?? "").toLowerCase() === String(label).toLowerCase()).length;
  const armed = (job) => {
    if (job.action === "heal" || job.action === "command") return true;
    if (job.role) return roleCount(job.role) > 0;
    if (!job.session || job.session === ALL_SESSIONS) return true;
    return byName.has(job.session);
  };
  // a command job has no session at all, so this has to survive null
  const target = (session, action, role) => {
    if (action === "sweep") return `fleet → ${session ?? "-"}`;
    if (action === "heal") return "drift (up --drift)";
    if (action === "command") return "$ (localhost)";
    if (role) return `role ${role}`;
    if (session === ALL_SESSIONS) return "all sessions";
    const owner = byName.get(session);
    return owner?.node ? `${session} @${owner.node}` : session ?? "-";
  };
  // A paused job is still a job: keep the row, but say in the NEXT column that
  // nothing is coming, so a silenced reminder cannot be mistaken for a broken tick.
  // A status can be a sentence now ("deferred: every session moved within 10m …").
  // The table stays readable by keeping the verdict word and clipping the rest;
  // `pp why <id>` and --json still carry it whole.
  const clip = (text, width = 34) => {
    const value = String(text ?? "-");
    if (value.length <= width) return value;
    return `${value.slice(0, width - 1).replace(/[ ,—]+$/, "")}…`;
  };
  const verdictOf = (text) => String(text ?? "-").split(":")[0];
  const table = records.map((row) => [
    row.id,
    target(row.session, row.action, row.role),
    row.schedule,
    row.paused ? "paused" : row.next,
    String(row.runs),
    verdictOf(row.last) === row.last ? clip(row.last) : `${verdictOf(row.last)} ${ui.paint("dim", "…")}`,
  ]);
  const widths = headers.map((h, i) => Math.max(h.length, ...table.map((row) => row[i].length)));
  const pad = (value, width) => value + " ".repeat(Math.max(0, width - value.length));
  ui.out(ui.paint("bold", headers.map((h, i) => pad(h, widths[i])).join("  ").trimEnd()));
  table.forEach((row, at) => {
    const colored = [...row];
    colored[0] = ui.paint("dim", colored[0]);
    const record = records[at];
    if (!armed(jobs[at])) colored[1] = ui.paint("yellow", `${colored[1]} !`);
    colored[3] = record.paused
      ? ui.paint("dim", colored[3])
      : record.late
        ? ui.paint("yellow", colored[3])
        : ui.paint("cyan", colored[3]);
    ui.out(colored.map((cell, index) => pad(cell, widths[index])).join("  ").trimEnd());
  });
  const paused = records.filter((row) => row.paused).length;
  if (paused) {
    ui.out(ui.paint("dim", `${paused} paused — bring one back with: pp cron resume <id>`));
  }
  // a deferred job is a job that waited, not one that broke — say which, because
  // "late 29m" next to "deferred" is the pair nobody should have to guess about
  const deferred = records.filter((row) => String(row.last).startsWith("deferred"));
  if (deferred.length) {
    ui.out(
      ui.paint(
        "dim",
        `${deferred.length} deferred — nothing was sent (target busy, drained or quiet); the next tick retries: pp why ${deferred[0].id}`,
      ),
    );
  }
  const lost = jobs.filter((job) => !armed(job));
  if (lost.length) {
    ui.out(ui.paint("yellow", `${lost.length} job(s) point at nothing — pp why ${lost[0].id} · pp cron retarget ${lost[0].id} …`));
  }
  // Say the loud thing out loud: a fan-out job that runs often is not free, and
  // the person who added it (probably at 2am) is the one who should see the bill.
  // `turns` is the bill if every fire lands; `actual` is what has happened so far.
  // With --idle-after or busy targets the first can be 30x the second, and quoting
  // only the ceiling makes a quiet job look expensive.
  const metered = (job) => {
    const created = job.createdAt ? Date.parse(job.createdAt) : NaN;
    const days = Number.isFinite(created) ? (now.getTime() - created) / 86_400_000 : 0;
    const runs = Number(job.runs ?? 0);
    return days >= 1 / 24 && runs > 0 ? runs / days : null;
  };
  const loud = jobs
    .filter((job) => !job.paused)
    .map((job) => ({
      id: job.id,
      turns: Math.round(deliveriesPerDay(job.schedule, { now }) * deliveryTargets(job, sessions)),
      actual: metered(job),
      runs: Number(job.runs ?? 0),
    }))
    .filter((entry) => entry.turns >= 200)
    .sort((a, b) => b.turns - a.turns);
  if (loud.length) {
    const worst = loud[0];
    const measured =
      worst.actual !== null && worst.actual * 2 < worst.turns
        ? ui.paint("dim", ` — it has actually delivered ${Math.round(worst.actual)} a day (${worst.runs} runs so far)`)
        : ui.paint("dim", "");
    ui.out(
      ui.paint("dim", `${worst.id} could cost up to ${worst.turns} agent turn(s) a day`) +
        measured +
        ui.paint("dim", ` · pp cron pause ${worst.id} to silence it`),
    );
  }
  // a deferred job is late on purpose: counting it here would send the reader to
  // check the tick, which is running fine
  const late = records.filter((row) => row.late && !row.paused && !String(row.last).startsWith("deferred")).length;
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
  // --idle-after: nudge only sessions that have actually gone quiet
  const idleAfter = options.idleAfter ? parseDuration(options.idleAfter, { what: "--idle-after" }) : 0;
  if (options.idleAfter && !idleAfter) throw new CronError("--idle-after needs a duration bigger than zero (try 10m)");
  if (idleAfter && (healing || sweeping || command)) {
    throw new CronError("--idle-after only applies to prompts sent to sessions");
  }
  // --window: do not nudge while people are asleep
  const window = options.window ? parseWindow(options.window, { what: "--window" }) : null;
  if (window && (healing || sweeping)) {
    throw new CronError("--window only applies to prompts sent to sessions");
  }

  // --max-per-day: a fan-out job is a firehose unless somebody caps it
  const maxPerDay = options.maxPerDay === undefined ? 0 : Number(options.maxPerDay);
  if (options.maxPerDay !== undefined && (!Number.isInteger(maxPerDay) || maxPerDay <= 0)) {
    throw new CronError("--max-per-day needs a whole number bigger than zero (try 24)");
  }
  if (maxPerDay && (healing || sweeping || command)) {
    throw new CronError("--max-per-day only applies to prompts sent to sessions");
  }

  // --timeout: a command job always has a deadline, but the default is a guess
  const commandTimeout = options.commandTimeout === undefined ? null : Number(options.commandTimeout);
  if (options.commandTimeout !== undefined && (!Number.isFinite(commandTimeout) || commandTimeout <= 0)) {
    throw new CronError("--timeout needs a number of seconds bigger than zero (try 600)");
  }
  if (commandTimeout !== null && !command) {
    throw new CronError("--timeout only applies to --command jobs (a prompt to a session waits as long as the agent takes)");
  }

  const schedule = buildSchedule({ at: options.in ? new Date(Date.now() + parseDuration(options.in, { what: "--in" }) * 1000).toISOString() : options.at, every: options.every, cron: options.cronExpr });

  let session = null;
  let targetRole = null;
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
  } else if (options.role) {
    // per-role delivery: the same label that filters `pp status --role`
    if (options.session) throw new CronError("give either --session <name|#> or --role <label>, not both");
    if (command) throw new CronError("--role takes a prompt — a command runs once, not per session");
    if (!config) throw new CronError("--role needs a config to read the labels from");
    const targets = roleTargets(config, options.role);
    if (!targets.length) {
      const inUse = [...new Set(config.sessions.map((entry) => entry.role).filter(Boolean))];
      throw new CronError(
        `no session has role "${options.role}"${inUse.length ? ` — roles in use: ${inUse.join(", ")} (pp role --list)` : " (pp role --list)"}`,
      );
    }
    targetRole = targets[0].role;
    session = null;
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
    ...(healing
      ? {}
      : sweeping
        ? { session, socket }
        : command
          ? { command, ...(commandTimeout ? { timeout: commandTimeout } : {}) }
          : targetRole
            ? { prompt: text, role: targetRole, socket }
            : { prompt: text, session, socket }),
    schedule,
    catchUp: options.catchUp ? parseDuration(options.catchUp, { what: "--catch-up" }) : DEFAULT_CATCH_UP_SECONDS,
    startSession: Boolean(options.start),
    ...(idleAfter ? { idleAfter } : {}),
    ...(window ? { window } : {}),
    ...(maxPerDay ? { maxPerDay } : {}),
    configPath,
    createdAt: new Date().toISOString(),
    runs: 0,
  };

  const due = nextRun(job);
  if (options.dryRun) {
    const who = targetRole ? `role ${targetRole}` : `session ${session}`;
    const deadline = job.timeout ? ` (killed after ${job.timeout}s)` : "";
    ui.out(`[dry-run] would schedule ${job.id}: ${describeSchedule(schedule)} → ${job.action === "heal" ? "heal (up --drift)" : job.action === "command" ? `$ ${command}` : who}${deadline}`);
    ui.out(`[dry-run] first run ${due ? due.toISOString() : "never"}`);
    if (idleAfter) ui.out(`[dry-run] only sessions quiet for ${formatDuration(idleAfter)} or more are nudged`);
    if (window) ui.out(`[dry-run] nothing is sent between ${describeWindow(window)}`);
    if (maxPerDay) ui.out(`[dry-run] at most ${maxPerDay} delivery(ies) a day`);
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
    detail: `${describeSchedule(schedule)} → ${job.action === "command" ? `$ ${command}` : targetRole ? `role ${targetRole}` : session}`,
    result: "ok",
  });
  const who = targetRole ? `role ${targetRole}` : `session ${session}`;
  ui.info(`${ui.paint("green", "scheduled")} ${job.id}  ${describeSchedule(schedule)}  →  ${job.action === "heal" ? "heal (up --drift)" : job.action === "command" ? `$ ${command}` : who}`);
  ui.info(ui.paint("dim", `first run: ${due ? due.toLocaleString() : "never"}   cancel with: pp cron rm ${job.id}`));
  if (!options.start && job.action === "prompt" && !targetRole && session !== ALL_SESSIONS) {
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
/**
 * `pp backup [--keep N] [--list]`: one directory per run, holding what pp reads.
 *
 * Deliberately a plain copy, not a tarball: at 3am `ls` and `cat` should be
 * enough, and a dependency-free restore is the point.
 */
async function cmdBackup(config, options, ui) {
  const env = process.env;
  const target = options.out ? expandPath(String(options.out), env) : backupDir(env);
  if (options.verify !== undefined) {
    const ref = String(options.verify) || "latest";
    const all = listBackups(target);
    const chosen =
      ref === "latest"
        ? all[all.length - 1]
        : ref.includes("/")
          ? { name: basename(ref), path: expandPath(ref, env) }
          : all.find((entry) => entry.name === ref || entry.name.startsWith(ref));
    if (!chosen) {
      ui.error(`no backup "${ref}" — see: pp backup --list`);
      process.exitCode = 2;
      return;
    }
    const report = verifyBackup(chosen.path);
    if (ui.json) {
      ui.out(JSON.stringify({ backup: chosen.name, ...report }, null, 2));
    } else {
      ui.out(`${ui.paint("bold", chosen.name)}  ${report.files.length} file(s)`);
      for (const file of report.files) {
        const size = file.bytes === null ? "gone" : humanBytes(file.bytes);
        ui.out(`  ${file.name.padEnd(12)} ${file.ok ? ui.paint("green", "ok") : ui.paint("red", `bad — ${size}`)}`);
      }
      if (report.ok) ui.out(ui.paint("dim", "every file is the size the manifest recorded"));
      for (const line of report.problems) ui.error(line);
    }
    if (!report.ok) process.exitCode = 1;
    return;
  }
  if (options.list) {
    const all = listBackups(target);
    if (ui.json) {
      ui.out(JSON.stringify({ dir: target, backups: all.map((entry) => ({ name: entry.name, ...describeBackup(entry.path) })) }, null, 2));
      return;
    }
    if (!all.length) {
      ui.info(`no backups in ${target}`);
      return;
    }
    for (const entry of all) {
      const { at, files } = describeBackup(entry.path);
      const bytes = files.reduce((sum, file) => sum + (file.bytes ?? 0), 0);
      ui.out(`${entry.name}  ${humanBytes(bytes).padStart(9)}  ${files.length} file(s)${at ? ui.paint("dim", `  ${at}`) : ""}`);
    }
    ui.out(ui.paint("dim", `${all.length} backup(s) in ${target}`));
    return;
  }

  const plan = backupPlan(config?.path ?? null, env);
  const keep = options.keep !== undefined ? Number(options.keep) : BACKUP_KEEP;
  if (!Number.isFinite(keep) || keep < 1) {
    ui.error(`--keep wants a positive number, got "${options.keep}"`);
    process.exitCode = 2;
    return;
  }
  if (options.dryRun) {
    for (const entry of plan.filter((item) => existsSync(item.path))) ui.out(`[dry-run] would copy ${entry.name}  ${entry.path}`);
    ui.out(`[dry-run] would write ${join(target, "<time>")}/ and keep ${keep}`);
    return;
  }
  const written = writeBackup(target, plan);
  if (ui.json) {
    ui.out(JSON.stringify({ dir: written.dir, keep, files: written.files.map((file) => ({ name: file.name, bytes: file.bytes })) }, null, 2));
  } else if (!written.files.length) {
    ui.warn(`nothing to copy — no config and no state files (${target})`);
  } else {
    const bytes = written.files.reduce((sum, file) => sum + file.bytes, 0);
    ui.out(`${ui.paint("bold", written.dir)}  ${written.files.length} file(s), ${humanBytes(bytes)}`);
    for (const file of written.files) ui.out(`  ${file.name.padEnd(12)} ${humanBytes(file.bytes)}`);
  }
  const pruned = pruneBackups(target, keep);
  if (pruned.length) ui.out(ui.paint("dim", `pruned ${pruned.length} older backup(s), keeping ${keep}`));
  note("backup", config?.path ? basename(config.path) : "state files", { detail: `${written.files.length} file(s) → ${written.dir}` });
}

/** `pp restore <backup|latest>` — puts the files back, after showing what changes. */
async function cmdRestore(config, options, ui) {
  const env = process.env;
  const target = options.out ? expandPath(String(options.out), env) : backupDir(env);
  const ref = (options.names ?? [])[0] ?? "latest";
  const all = listBackups(target);
  const chosen =
    ref === "latest"
      ? all[all.length - 1]
      : ref.includes("/")
        ? { name: basename(ref), path: expandPath(ref, env) }
        : all.find((entry) => entry.name === ref || entry.name.startsWith(ref));
  if (!chosen) {
    ui.error(`no backup "${ref}" — see: pp backup --list`);
    process.exit(2);
  }
  const plan = restorePlan(config?.path ?? null, chosen.path, env);
  if (!plan.length) {
    ui.error(`${chosen.name} holds nothing pp knows how to restore — pp backup --list shows what it has`);
    process.exit(2);
  }
  const configEntry = plan.find((entry) => entry.name === "plus.yml");
  const changes =
    configEntry && existsSync(configEntry.to) && existsSync(configEntry.from)
      ? (() => {
          try {
            return configChanges(readConfigText(configEntry.to), readConfigText(configEntry.from), { limit: 5 });
          } catch {
            return null;
          }
        })()
      : null;

  if (ui.json) {
    ui.out(JSON.stringify({ backup: chosen.name, dryRun: Boolean(options.dryRun), files: plan.map(({ name, to, bytes }) => ({ name, to, bytes })), config: changes }, null, 2));
    if (options.dryRun) return;
  } else {
    ui.out(`${ui.paint("bold", chosen.name)}  →  ${plan.length} file(s)`);
    for (const entry of plan) {
      const same = existsSync(entry.to) && readFileSync(entry.to, "utf8") === readFileSync(entry.from, "utf8");
      ui.out(`  ${entry.name.padEnd(12)} ${same ? ui.paint("dim", "unchanged") : ui.paint("yellow", "will change")}`);
    }
    if (changes && changes.total) {
      ui.out("");
      for (const line of changes.lines) ui.out(`  ${ui.paint("dim", line)}`);
      if (changes.total > changes.lines.length) ui.out(ui.paint("dim", `  (+${changes.total - changes.lines.length} more)`));
    }
  }
  if (options.dryRun) {
    ui.out(ui.paint("dim", "dry run — nothing was written"));
    return;
  }
  if (!options.force) {
    ui.error(`restoring overwrites ${plan.length} file(s) — add --force, or --dry-run to look first`);
    process.exit(1);
  }
  // a backup is only a backup if it still parses: restoring a truncated file
  // would take a working machine and give back a broken one
  if (configEntry) {
    try {
      loadConfig({ configPath: configEntry.from, cwd: process.cwd() });
    } catch (error) {
      ui.error(`that backup's plus.yml does not parse — ${firstLine(error.message, 160)}`);
      ui.out(ui.paint("dim", `pp backup --list  ·  pp restore <another>  ·  pp restore ${chosen.name} --dry-run to look`));
      process.exit(1);
    }
  }
  // the state we are about to destroy is worth one last copy
  const safety = writeBackup(target, backupPlan(config?.path ?? null, env));
  let restored = 0;
  const failed = [];
  for (const entry of plan) {
    try {
      mkdirSync(dirname(entry.to), { recursive: true });
      copyFileSync(entry.from, entry.to);
      restored += 1;
    } catch (error) {
      failed.push(`${entry.name}: ${error.message}`);
    }
  }
  ui.out(`restored ${restored} file(s) from ${chosen.name}${failed.length ? ui.paint("red", `, ${failed.length} failed`) : ""}`);
  for (const line of failed) ui.error(line);
  // and prove it: if what landed cannot be read, put the previous one back
  if (!failed.length && configEntry) {
    try {
      loadConfig({ configPath: configEntry.to, cwd: process.cwd() });
    } catch (error) {
      const spare = join(safety.dir, "plus.yml");
      if (existsSync(spare)) {
        copyFileSync(spare, configEntry.to);
        ui.error(`the restored plus.yml does not parse (${firstLine(error.message, 120)}) — put the previous one back`);
        ui.out(ui.paint("dim", `that one is also in ${safety.dir}`));
        process.exitCode = 1;
        return;
      }
      ui.error(`the restored plus.yml does not parse (${firstLine(error.message, 120)}) — nothing to roll back to`);
      process.exitCode = 1;
      return;
    }
  }
  ui.out(ui.paint("dim", `what was there before is in ${safety.dir}`));
  note("restore", chosen.name, { detail: `${restored} file(s)`, result: failed.length ? "partial" : "changed" });
  if (failed.length) process.exitCode = 1;
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
  printCronJobs(jobs, ui, new Date(), config?.sessions ?? []);
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

async function cmdCronPause(config, options, ui, { paused = true } = {}) {
  const ids = [...options.names];
  if (ids.length === 0) {
    ui.error(`usage: pp cron ${paused ? "pause" : "resume"} <id>`);
    process.exit(2);
  }
  let touched = 0;
  for (const id of ids) {
    if (!setJobPaused(id, paused)) {
      ui.error(`no job "${id}"`);
      process.exitCode = 2;
      continue;
    }
    touched += 1;
    note(paused ? "cron.pause" : "cron.resume", id, { dryRun: options.dryRun });
    ui.info(paused ? `paused ${id} — its schedule and history are kept` : `resumed ${id}`);
  }
  if (touched && paused) ui.info(ui.paint("dim", `back on: pp cron resume ${ids[0]}`));
}

/**
 * `pp cron set <id> --max-per-day 96 --idle-after 30m` — change what a job
 * considers "too much" without deleting it and losing its history.
 */
async function cmdCronSet(config, options, ui) {
  const [id] = options.names ?? [];
  if (!id) {
    ui.error("which job? pp cron set <id> --max-per-day <n>");
    process.exit(2);
  }
  const jobs = readJobs();
  const job = jobs.find((entry) => entry.id === id);
  if (!job) {
    ui.error(`no job "${id}" — see: pp cron ls`);
    process.exit(2);
  }
  const off = (value) => ["none", "off", "0", ""].includes(String(value).toLowerCase());
  const patch = {};
  const orUndef = (value) => (value === undefined || value === null || value === "" ? undefined : value);
  const every = orUndef(options.every);
  const cronExpr = orUndef(options.cronExpr);
  const inText = orUndef(options.in);
  const at = orUndef(options.at);
  if ([every, cronExpr, inText, at].filter((value) => value !== undefined).length > 1) {
    throw new CronError("pick one of --every, --cron, --in, --at");
  }
  if (every || cronExpr || inText || at) {
    const schedule = buildSchedule({
      at: at ?? (inText ? new Date(Date.now() + parseDuration(inText, { what: "--in" }) * 1000).toISOString() : undefined),
      every,
      cron: cronExpr,
    });
    patch.schedule = schedule;
    if (schedule.kind === "once") {
      // a one-shot fires on its own timestamp, so the old run has to be forgotten
      patch.lastRun = null;
      patch.done = null;
    }
  }
  const promptText = orUndef(options.prompt) ?? (options.names.length > 1 ? options.names.slice(1).join(" ") : undefined);
  if (promptText !== undefined && options.command !== undefined) {
    throw new CronError("give a prompt or a command, not both");
  }
  if (promptText !== undefined) {
    patch.action = "prompt";
    patch.prompt = promptText;
    patch.command = null;
  }
  if (options.command !== undefined) {
    patch.action = "command";
    patch.command = options.command;
    patch.prompt = null;
  }
  const parseCap = (value) => {
    if (off(value)) return null;
    const n = Number(value);
    if (!Number.isInteger(n) || n <= 0) throw new CronError("--max-per-day needs a whole number bigger than zero (try 24)");
    return n;
  };
  if (options.maxPerDay !== undefined) patch.maxPerDay = parseCap(options.maxPerDay);
  if (options.idleAfter !== undefined) {
    patch.idleAfter = off(options.idleAfter) ? null : parseDuration(options.idleAfter, { what: "--idle-after" });
  }
  if (options.window !== undefined) {
    patch.window = off(options.window) ? null : parseWindow(options.window, { what: "--window" });
  }
  if (options.catchUp !== undefined) {
    if (off(options.catchUp)) patch.catchUp = null;
    else {
      const seconds = parseDuration(options.catchUp, { what: "--catch-up" });
      patch.catchUp = Math.max(1, seconds);
    }
  }
  if (!Object.keys(patch).length) {
    ui.error("nothing to change — try: pp cron set <id> --max-per-day 96 | --idle-after 30m | --window 23:00-08:00 | --every 30m | \"...\"");
    process.exit(2);
  }
  const show = (key, value) => {
    if (value === null || value === undefined) return "(none)";
    if (key === "window") return describeWindow(value);
    if (key === "schedule") return describeSchedule(value);
    if (key === "idleAfter" || key === "catchUp") return formatDuration(Number(value));
    return String(value);
  };
  const changed = Object.entries(patch).filter(([key, value]) => show(key, job[key] ?? null) !== show(key, value));
  if (!changed.length && !("schedule" in patch)) {
    ui.info(`nothing changes — ${id} already looks like that`);
    return;
  }
  if (options.dryRun) {
    for (const [key, value] of (changed.length ? changed : Object.entries(patch))) {
      ui.out(`[dry-run] ${id} ${key}: ${show(key, job[key] ?? null)} -> ${show(key, value)}`);
    }
    return;
  }
  const result = updateJob(id, patch, process.env);
  if (!result) {
    ui.error(`no job "${id}" — see: pp cron ls`);
    process.exit(2);
  }
  const lines = Object.keys(patch)
    .map((key) => `${key}: ${show(key, result.before[key])} -> ${show(key, result.after[key])}`)
    .filter((line) => {
      // groups: 1 = key, 2 = before, 3 = after — the key is not the before value
      const [, , before, after] = /^([^:]+): (.*) -> (.*)$/.exec(line) ?? [];
      return before !== after;
    });
  for (const line of lines) ui.out(`${id} ${line}`);
  if (lines.length) note("cron.set", id, { detail: lines.join(", ") });
}

async function cmdCronRetarget(config, options, ui) {
  const [id, ...rest] = options.names;
  if (!id) {
    ui.error("usage: pp cron retarget <id> --session <name|#> | --role <label> | --all");
    process.exit(2);
  }
  if (rest.length) {
    ui.error(`unexpected "${rest[0]}" — a job has one target`);
    process.exit(2);
  }
  const wantsRole = typeof options.role === "string" && options.role.trim() !== "";
  if (wantsRole && options.all) {
    ui.error("give either --role <label> or --all, not both");
    process.exit(2);
  }
  const withRole = wantsRole ? options.role.trim() : null;
  let targetName;
  if (options.all) {
    targetName = ALL_SESSIONS;
  } else if (!wantsRole) {
    const wanted = options.session;
    if (typeof wanted !== "string" || wanted === "") {
      ui.error("which session? --session <name|#> (or --role <label>, or --all)");
      process.exit(2);
    }
    const [session] = "0123456789".includes(wanted[0])
      ? selectSessions(config, [wanted], ui)
      : [(config.sessions ?? []).find((s) => s.name === wanted || s.tmuxName === wanted)];
    if (!session) {
      ui.error(`no session "${wanted}" in ${config.path}`);
      process.exit(2);
    }
    targetName = session.name;
  } else if (!roleTargets(config, withRole).length) {
    const inUse = rolesInUse(config);
    ui.error(`no session has role "${withRole}"${inUse.length ? ` (roles in use: ${inUse.join(", ")})` : ""}`);
    process.exit(2);
  }

  const jobs = readJobs();
  const job = jobs.find((entry) => entry.id === id);
  if (!job) {
    ui.error(`no job "${id}"`);
    process.exit(2);
  }
  if (["command", "heal", "sweep"].includes(job.action)) {
    ui.error(`"${id}" is a built-in job (${job.action}) — it has no target to move`);
    process.exit(2);
  }

  const changed = setJobTarget(id, withRole ? { role: withRole } : { session: targetName });
  if (!changed) {
    ui.error(`no job "${id}"`);
    process.exit(2);
  }
  const show = (side) => (side.role ? `role "${side.role}"` : side.session === ALL_SESSIONS ? "all sessions" : `session "${side.session}"`);
  const from = show(changed.before);
  const to = show(changed.after);
  if (from === to && !options.dryRun) {
    ui.out(`retarget ${id}: already on ${to}`);
    return;
  }
  note("cron.retarget", id, { detail: `${from} -> ${to}`, dryRun: options.dryRun });
  ui.info(`retargeted ${id}: ${from} -> ${to}`);
  ui.info(ui.paint("dim", `its schedule and history are kept — pp cron ls`));
}

/**
 * What a job would do right now, without doing any of it — the question you ask
 * before enabling a broadcast. Same gates as the tick: missing session, drained
 * machine, a session that moved recently (--idle-after), a busy agent.
 */
export function deliveryPlan(tmux, job, { config = null } = {}) {
  let live;
  try {
    live = tmux.listSessions();
  } catch {
    return { targets: [], note: "tmux is not answering here" };
  }
  let names;
  if (job.session === ALL_SESSIONS) {
    names = [...live.keys()].sort();
  } else if (job.role) {
    names = config ? roleTargets(config, job.role).map((session) => session.tmuxName) : [];
    if (!names.length) return { targets: [], note: `no session carries role "${job.role}"` };
  } else {
    names = [job.session];
  }
  // a daily cap is checked before anything else: past it, nothing is sent no
  // matter how idle, free or healthy the target looks
  const capped = job.maxPerDay ? dailyRuns(job) >= Number(job.maxPerDay) : false;
  const targets = names.map((name) => {
    const activity = live.get(name)?.activity;
    if (capped) return { name, verdict: "cap", sent: dailyRuns(job), cap: Number(job.maxPerDay) };
    if (config && drainedTarget(config, name)) return { name, verdict: "drained" };
    if (!live.has(name)) return { name, verdict: "down" };
    if (tooFresh(activity, job.idleAfter)) {
      const quiet = quietSeconds(activity);
      return { name, verdict: "lately", quiet };
    }
    if (tmux.isAgentBusy(name)) return { name, verdict: "busy" };
    return { name, verdict: "send" };
  });
  return { targets, note: null };
}

async function cmdCronDryRun(config, options, ui) {
  if (!options.names.length) throw new CronError("which job? pp cron dryrun <id>");
  const jobs = readJobs();
  const rows = [];
  for (const id of options.names) {
    const job = jobs.find((entry) => entry.id === id);
    if (!job) {
      ui.error(`no job "${id}"`);
      process.exitCode = 2;
      continue;
    }
    if (job.action === "command") {
      rows.push({ id, target: "$ (localhost)", verdict: "run", detail: job.command });
      continue;
    }
    if (job.action === "heal") {
      rows.push({ id, target: "drift", verdict: "run", detail: "pp up --drift" });
      continue;
    }
    if (job.action === "sweep") {
      rows.push({ id, target: `fleet → ${job.session ?? "-"}`, verdict: "run", detail: "fleet report" });
      continue;
    }
    const config = jobConfig(job);
    if (job.maxPerDay && dailyRuns(job) >= Number(job.maxPerDay)) {
      rows.push({ id, target: job.session === ALL_SESSIONS ? "all sessions" : job.session, verdict: "cap", detail: `already delivered ${dailyRuns(job)} of ${job.maxPerDay} today` });
      continue;
    }
    if (inQuietHours(job)) {
      rows.push({ id, target: job.session === ALL_SESSIONS ? "all sessions" : job.session, verdict: "quiet", detail: `nothing is sent between ${describeWindow(job.window)}` });
      continue;
    }
    const tmux = makeTmux(config ?? { tmuxSocket: null, nodes: [] }, options);
    if (job.role) {
      // a role job hops machines, so look at each session with its own handle
      const plan = { targets: [] };
      for (const session of config ? roleTargets(config, job.role) : []) {
        const own = makeTmux(config, options, session);
        const one = deliveryPlan(own, { ...job, role: null, session: session.tmuxName }, { config });
        plan.targets.push(...one.targets);
        if (one.note) plan.note = one.note;
      }
      rows.push({ id, target: `role ${job.role}`, plan });
      continue;
    }
    rows.push({ id, target: job.session === ALL_SESSIONS ? "all sessions" : job.session, plan: deliveryPlan(tmux, job, { config }) });
  }

  const label = { send: "would send", busy: "busy — skipped", lately: "moved recently — skipped", down: "not running", drained: "drained machine", run: "would run", quiet: "quiet hours — skipped", cap: "daily cap reached — skipped" };
  if (ui.json) {
    // the plan is a promise about a tick: keep the per-target verdicts and their
    // reasons, and say what the summary sentence would be
    ui.out(
      JSON.stringify(
        rows.map((row) => row.plan
          ? { id: row.id, target: row.target, plan: row.plan }
          : { id: row.id, target: row.target, verdict: row.verdict ?? null, detail: row.detail ?? null }),
        null,
        2,
      ),
    );
    return;
  }
  for (const row of rows) {
    if (row.verdict) {
      ui.out(`${ui.paint("bold", row.id)}  ${row.target}  ${ui.paint("cyan", label[row.verdict])}${row.detail ? `  ${ui.paint("dim", row.detail)}` : ""}`);
      continue;
    }
    if (row.plan.note) {
      ui.out(`${ui.paint("bold", row.id)}  ${row.target}  ${ui.paint("yellow", row.plan.note)}`);
      continue;
    }
    const count = (verdict) => row.plan.targets.filter((entry) => entry.verdict === verdict).length;
    const when = row.plan.targets
      .filter((entry) => entry.verdict === "lately")
      .map((entry) => `${entry.name} ${entry.quiet === null ? "?" : shortAge(entry.quiet)}`)
      .slice(0, 4);
    ui.out(
      `${ui.paint("bold", row.id)}  ${row.target}  ${ui.paint("cyan", `would send to ${count("send")} of ${row.plan.targets.length}`)}` +
        (count("busy") ? ui.paint("dim", ` · ${count("busy")} busy`) : "") +
        (count("lately") ? ui.paint("dim", ` · ${count("lately")} moved recently${when.length ? ` (${when.join(", ")})` : ""}`) : "") +
        (count("down") ? ui.paint("dim", ` · ${count("down")} not running`) : "") +
        (count("drained") ? ui.paint("dim", ` · ${count("drained")} drained`) : ""),
    );
    for (const entry of row.plan.targets) {
      if (entry.verdict === "send") continue;
      ui.out(`    ${entry.name.padEnd(18)} ${ui.paint("dim", label[entry.verdict])}${entry.quiet !== null && entry.quiet !== undefined ? ` (quiet ${shortAge(entry.quiet)})` : ""}`);
    }
  }
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
    // one writer for job state: it also feeds the daily cap and the deferral
    // streak, which a hand-rolled three-line update kept forgetting
    recordRun(job, result.status, { output: result.output ?? null });
    const paint = result.status === "delivered" ? "green" : "yellow";
    // "delivered" on its own hides the interesting part: how many, and what
    // was refused. The tick writes the same text to cron.log.
    const detail = result.text ? ` ${ui.paint("dim", `— ${result.text}`)}` : "";
    // a status with a sentence inside reads badly with the id tacked on the end
    const sentence = result.status.includes(": ");
    ui.info(`${ui.paint(paint, result.status)} ${sentence ? ui.paint("dim", `[${id}]`) : id}${detail}`);
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
  if (result.locked) {
    if (!options.quiet) ui.info(ui.paint("dim", "another tick is running; skipped"));
    return;
  }
  if (ui.json) {
    ui.out(JSON.stringify(result, null, 2));
    return;
  }
  if (!options.quiet) {
    // "2 skipped" is a number without a reason, and the reason is the whole
    // point: quiet hours is not the same news as a delivery that failed
    const reasons = new Map();
    for (const entry of result.skipped) {
      const reason = String(entry.reason ?? "other").replace(/^skipped: /, "").split(" — ")[0];
      reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
    }
    const why = reasons.size ? ` (${[...reasons].map(([reason, count]) => `${count} ${reason}`).join(", ")})` : "";
    ui.info(`${result.ran.length} delivered, ${result.skipped.length} skipped${why}, ${result.total} job(s) left`);
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
    case "pause":
    case "hold":
      return cmdCronPause(config, { ...restOptions, names: rest }, ui, { paused: true });
    case "resume":
    case "unpause":
      return cmdCronPause(config, { ...restOptions, names: rest }, ui, { paused: false });
    case "set":
    case "edit":
      return cmdCronSet(config, { ...restOptions, names: rest }, ui);
    case "retarget":
    case "reaim":
      return cmdCronRetarget(config, { ...restOptions, names: rest }, ui);
    case "dryrun":
    case "dry-run":
    case "preview":
      return cmdCronDryRun(config, { ...restOptions, names: rest }, ui);
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
      throw new CronError(`unknown cron subcommand: ${sub} (add, ls, rm, run, pause, resume, tick, install, uninstall, status, logs)`);
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
      } catch (error) {
        // `pp new` works without any config file, but a config the user pointed
        // at that does not parse is not "no config" — say what is wrong
        if (options.config) throw error;
        config = null;
      }
      return cmdNew(config, options, ui);
    }
    case "up":
    case "start": {
      // `pp` with no argument lands here too (start is the up alias), so the
      // flag decides which of the two the user meant
      if (options.firstScreen) return cmdStart(options, ui);
      const config = requireConfig(options, ui);
      return cmdUp(config, options, ui);
    }
    case "sync": {
      return cmdSync(requireConfig(options, ui), options, ui);
    }
    case "fleet": case "all":
      return cmdFleet(tryLoadConfig(options), options, ui);
    case "rename": case "ren": case "mv-name": {
      const config = requireConfig(options, ui);
      return cmdRename(config, options, ui);
    }
    case "adopt": {
      const config = requireConfig(options, ui);
      return cmdAdopt(config, options, ui);
    }
    case "bind": {
      const config = requireConfig(options, ui);
      return cmdBind(config, options, ui);
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
      const readOnly = ["ls", "list", "status", "test", "ping", "probe"].includes(sub);
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
    case "backup": {
      // read-only unless it writes a new directory: a broken config must not
      // stop you from taking a copy of it
      const config = tryLoadConfig(options);
      return cmdBackup(config, options, ui);
    }
    case "restore": {
      const config = tryLoadConfig(options);
      return cmdRestore(config, options, ui);
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
    case "working":
    case "doing": {
      const config = requireConfig(options, ui);
      return cmdBusy(config, options, ui);
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
