#!/usr/bin/env node
import { readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { runCommand } from "../src/commands.js";
import { renderCommandHelp, renderOverview, suggestCommand } from "../src/help.js";

const VERSION = (() => {
  try {
    return JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
  } catch {
    return "0.0.0";
  }
})();


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
      // Everything after `--` is an opaque payload (a remote command, a prompt
      // with dashes in it), but the tokens before it are still names.
      options.rest = [...args];
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
        case "--once": options.once = true; break;
        case "--left": options.left = takeValue(flag, inline); break;
        case "--diag": options.diag = true; break;
        case "--all": options.all = true; break;
        case "--reconcile": options.reconcile = true; break;
        case "--quiet": options.quiet = true; break;
        case "--verbose": options.verbose = true; break;
        case "--lines": options.lines = Number(takeValue(flag, inline)) || 200; break;
        case "--no-enter": options.noEnter = true; break;
        case "--no-config": options.noConfig = true; break;
        case "--at": options.at = takeValue(flag, inline); break;
        case "--in": options.in = takeValue(flag, inline); break;
        case "--every": options.every = takeValue(flag, inline); break;
        case "--cron": options.cronExpr = takeValue(flag, inline); break;
        case "--session": options.session = takeValue(flag, inline); break;
        case "--command": options.command = takeValue(flag, inline); break;
        case "--catch-up": options.catchUp = takeValue(flag, inline); break;
        case "--start": options.start = true; break;
        case "--all": options.all = true; break;
        case "--via": options.via = takeValue(flag, inline); break;
        case "--now": options.now = takeValue(flag, inline); break;
        case "--log": options.log = takeValue(flag, inline); break;
        case "--print": options.print = true; break;
        case "--watch": {
          if (inline !== undefined) options.watch = Number(inline) || 300;
          else if (args.length > 0 && /^\d+$/.test(args[0])) options.watch = Number(args.shift());
          else options.watch = 300;
          break;
        }
        case "--dir": options.dir = takeValue(flag, inline); break;
        case "--agent": options.agent = takeValue(flag, inline); break;
        case "--log": options.log = true; break;
        case "--save": options.save = true; break;
        case "--attach": options.attach = true; break;
        case "--no-remote-pi": options.noRemotePi = true; break;
        case "--as": options.as = takeValue(flag, inline); break;
        case "--host": options.host = takeValue(flag, inline); break;
        case "--port": options.port = takeValue(flag, inline); break;
        case "--user": options.user = takeValue(flag, inline); break;
        case "--identity": options.identity = takeValue(flag, inline); break;
        case "--password": options.password = takeValue(flag, inline); break;
        case "--password-env": options.passwordEnv = takeValue(flag, inline); break;
        case "--note": options.note = takeValue(flag, inline); break;
        case "--node": options.node = takeValue(flag, inline); break;
        case "--timeout": options.timeout = Number(takeValue(flag, inline)); break;
        case "--from-ssh-config": options.fromSshConfig = takeValue(flag, inline); break;
        case "--wait": options.wait = Number(takeValue(flag, inline)) || 5000; break;
        case "--no-wait": options.noWait = true; break;
        case "--body-json": options.bodyJson = takeValue(flag, inline); break;
        case "--bin-dir": options.binDir = takeValue(flag, inline); break;
        case "--check": options.check = true; break;
        case "--registry": options.registry = takeValue(flag, inline); break;
        case "--reply": options.reply = Number(takeValue(flag, inline)) || 0; break;
        case "--local": options.local = true; break;
        case "--path": options.path = takeValue(flag, inline); break;
        case "--help": process.exit(showHelp(command));
        case "--version": process.stdout.write(`${VERSION}\n`); process.exit(0); break;
        default: fail(`unknown option: ${arg}`);
      }
      continue;
    }
    if (arg === "-C") { options.dir = takeValue(arg); continue; }
    if (arg === "-a") { options.attach = true; continue; }
    if (arg === "-c" || arg === "-q" || arg === "-v" || arg === "-n" || arg === "-h" || arg === "-V") {
      switch (arg) {
        case "-c": options.config = takeValue(arg); break;
        case "-q": options.quiet = true; break;
        case "-v": options.verbose = true; break;
        case "-n": options.lines = Number(takeValue(arg)) || 200; break;
        case "-h": process.exit(showHelp(command));
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

function showHelp(name) {
  if (!name) {
    process.stdout.write(renderOverview(VERSION));
    return 0;
  }
  const text = renderCommandHelp(VERSION, name);
  if (text) {
    process.stdout.write(text);
    return 0;
  }
  process.stderr.write(`error: unknown command: ${name}\n`);
  const suggestion = suggestCommand(name);
  if (suggestion) process.stderr.write(`did you mean 'pp help ${suggestion}'?\n`);
  else process.stderr.write("run 'pp help' to see the command list\n");
  return 2;
}

const { command, options } = parseArgs(process.argv.slice(2));
options.scriptPath = scriptPath();
options.version = VERSION;

if (!command) process.exit(showHelp(null));
if (command === "version") {
  process.stdout.write(`${VERSION}\n`);
  process.exit(0);
}
if (command === "help") process.exit(showHelp(options.names[0]));

try {
  await runCommand(command, options);
} catch (err) {
  process.stderr.write(`error: ${err?.message ?? String(err)}\n`);
  if (options.verbose && err?.stack) process.stderr.write(`${err.stack}\n`);
  process.exit(1);
}
