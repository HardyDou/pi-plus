#!/usr/bin/env node
import { readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { runCommand } from "../src/commands.js";

const VERSION = (() => {
  try {
    return JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
  } catch {
    return "0.0.0";
  }
})();

const HELP = `pi-farm ${VERSION} — keep your pi agents alive in tmux

Usage:
  pi-farm <command> [names...] [options]

Commands:
  up [names...]        Create/start configured sessions, detached (default: all)
  down [names...]      Stop sessions
  restart [names...]   Restart sessions (kill + up)
  status               Show config, tmux state, pi session and remote-pi name
  attach <name>        Attach to a session (starts it if missing)
  logs <name>          Print recent pane output (--lines N, default 200)
  send <name> "text"   Type text into the pane and press Enter (--no-enter)
  check                Validate the config without touching tmux
  doctor               Environment + config diagnostics
  init                 Write an example config to ~/.pi/farm.yml
  install              Install reboot autostart (systemd / launchd)
  uninstall            Remove the autostart unit
  version              Print the version

Options:
  -c, --config <path>  Config file (default: ./pi-farm.yml, then ~/.pi/farm.yml)
      --socket <name>  tmux socket name (overrides tmux.socket in the config)
      --json           Machine-readable output (up/down/status/check/doctor)
      --dry-run        Print what would happen; do not touch tmux or files
      --force          up: recreate already running sessions; init: overwrite
      --reconcile      up: autostart/watch mode; skip sessions stopped by hand
  -q, --quiet          Only errors
  -v, --verbose        Echo tmux commands
  -n, --lines <n>      logs: how many scrollback lines (default 200)
      --no-enter       send: do not press Enter
      --watch [secs]   install: also reconcile every N seconds (default 300)
      --print          install: print the unit file and exit
  -h, --help           Show this help
  -V, --version        Print the version

Config example:
  version: 1
  defaults:
    agent: pi
  sessions:
    - name: backend          # tmux session, pi name and remote-pi name
      cwd: ~/code/backend
      pi_session: 1a2b3c4d   # optional: resume this pi session id/path
    - name: docs
      cwd: ~/code/docs
      agent: pi
      remote_pi_name: docs
      env:
        TZ: Asia/Shanghai

Name mapping (all default to the session name):
  tmux session   tmux_name | name
  pi --name      pi_session_name | name
  remote-pi      remote_pi_name | name
`;

function fail(message) {
  process.stderr.write(`error: ${message}\n`);
  process.exit(2);
}

function parseArgs(argv) {
  const options = { names: [], cwd: process.cwd(), json: false, quiet: false, verbose: false };
  let command = null;
  const args = [...argv];

  const takeValue = (flag, inline) => {
    if (inline !== undefined) return inline;
    const next = args.shift();
    if (next === undefined) fail(`${flag} requires a value`);
    return next;
  };

  while (args.length > 0) {
    const arg = args.shift();
    if (arg === "--") {
      options.names.push(...args);
      break;
    }
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      const flag = eq === -1 ? arg : arg.slice(0, eq);
      const inline = eq === -1 ? undefined : arg.slice(eq + 1);
      switch (flag) {
        case "--config": options.config = takeValue(flag, inline); break;
        case "--socket": options.socket = takeValue(flag, inline); break;
        case "--json": options.json = true; break;
        case "--dry-run": options.dryRun = true; break;
        case "--force": options.force = true; break;
        case "--reconcile": options.reconcile = true; break;
        case "--quiet": options.quiet = true; break;
        case "--verbose": options.verbose = true; break;
        case "--lines": options.lines = Number(takeValue(flag, inline)) || 200; break;
        case "--no-enter": options.noEnter = true; break;
        case "--print": options.print = true; break;
        case "--watch": {
          if (inline !== undefined) options.watch = Number(inline) || 300;
          else if (args.length > 0 && /^\d+$/.test(args[0])) options.watch = Number(args.shift());
          else options.watch = 300;
          break;
        }
        case "--local": options.local = true; break;
        case "--path": options.path = takeValue(flag, inline); break;
        case "--help": process.stdout.write(HELP); process.exit(0); break;
        case "--version": process.stdout.write(`${VERSION}\n`); process.exit(0); break;
        default: fail(`unknown option: ${arg}`);
      }
      continue;
    }
    if (arg === "-c" || arg === "-q" || arg === "-v" || arg === "-n" || arg === "-h" || arg === "-V") {
      switch (arg) {
        case "-c": options.config = takeValue(arg); break;
        case "-q": options.quiet = true; break;
        case "-v": options.verbose = true; break;
        case "-n": options.lines = Number(takeValue(arg)) || 200; break;
        case "-h": process.stdout.write(HELP); process.exit(0); break;
        case "-V": process.stdout.write(`${VERSION}\n`); process.exit(0); break;
      }
      continue;
    }
    if (arg.startsWith("-") && arg !== "-") fail(`unknown option: ${arg}`);
    if (!command) command = arg;
    else options.names.push(arg);
  }

  return { command, options };
}

function scriptPath() {
  const argv1 = process.argv[1];
  try {
    return realpathSync(resolve(argv1));
  } catch {
    return resolve(argv1);
  }
}

const { command, options } = parseArgs(process.argv.slice(2));
options.scriptPath = scriptPath();

if (!command) {
  process.stdout.write(HELP);
  process.exit(0);
}
if (command === "version") {
  process.stdout.write(`${VERSION}\n`);
  process.exit(0);
}
if (command === "help") {
  process.stdout.write(HELP);
  process.exit(0);
}

try {
  await runCommand(command, options);
} catch (err) {
  process.stderr.write(`error: ${err?.message ?? String(err)}\n`);
  if (options.verbose && err?.stack) process.stderr.write(`${err.stack}\n`);
  process.exit(1);
}
