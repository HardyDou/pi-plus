import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { expandPath } from "./config.js";

/**
 * Machines a session can live on.
 *
 * A node is a plain ssh target: host, port, user and *one* way to authenticate
 * (an identity file, a password, or the name of an environment variable that
 * holds the password). Everything is registered in the same plus.yml as the
 * sessions, so one file describes the whole farm.
 */
export const NODE_KEYS = new Set([
  "name",
  "host",
  "port",
  "user",
  "identity",
  "password",
  "password_env",
  "note",
  "group",
  "tags",
  "guarded",
  "drained",
  "base_path",
  "defaults",
]);

/** Session settings a machine may set for every session that runs on it. */
export const NODE_DEFAULT_KEYS = new Set(["agent", "restart", "remote_pi_mode", "env", "args", "role"]);

export const DEFAULT_PORT = 22;
// the one definition; config.js re-exports it (it already imports this module,
// so the dependency must point this way round)
export const RESTART_POLICIES = ["no", "always", "on-failure", "unless-stopped"];
const NODE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const TAG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export class NodeError extends Error {
  constructor(message) {
    super(message);
    this.name = "NodeError";
  }
}

function asScalar(value) {
  return String(value == null ? "" : value).trim();
}

/**
 * Accept the shapes people actually paste: `user@host`, `host:2222`,
 * `user@host:2222`, `ssh://user@host:2222`. Anything given explicitly in
 * `user:`/`port:` wins over what the host string carried.
 */
export function splitTarget(host, user, port) {
  let rest = asScalar(host);
  rest = rest.replace(/^ssh:\/\//i, "");
  let outUser = asScalar(user) || null;
  let outPort = port === undefined || port === null || port === "" ? null : Number(port);
  const at = rest.lastIndexOf("@");
  if (at > 0) {
    outUser = outUser ?? rest.slice(0, at);
    rest = rest.slice(at + 1);
  }
  const colon = rest.lastIndexOf(":");
  if (colon > 0 && /^\d+$/.test(rest.slice(colon + 1))) {
    outPort = outPort ?? Number(rest.slice(colon + 1));
    rest = rest.slice(0, colon);
  }
  return { host: rest, user: outUser, port: outPort };
}

export function normalizeNode(raw, index, configPath = "<config>", warnings = []) {
  const where = `${configPath}: nodes[${index}]`;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new NodeError(`${where} must be a mapping`);
  }
  for (const key of Object.keys(raw)) {
    if (!NODE_KEYS.has(key)) warnings.push(`${configPath}: node "${raw.name ?? index}": unknown key "${key}" (ignored)`);
  }
  const name = asScalar(raw.name);
  if (!name) throw new NodeError(`${where}: name is required`);
  if (!NODE_NAME_RE.test(name)) {
    throw new NodeError(`${where}: name "${name}" must start with a letter or digit and use only letters, digits, ".", "_" or "-"`);
  }
  if (!asScalar(raw.host)) throw new NodeError(`${where}: host is required (the ip or dns name to ssh to)`);

  const target = splitTarget(raw.host, raw.user, raw.port);
  if (!target.host) throw new NodeError(`${where}: host "${raw.host}" has no host part`);
  if (target.port != null && (!Number.isInteger(target.port) || target.port < 1 || target.port > 65535)) {
    throw new NodeError(`${where}: port "${raw.port}" is not a port number (1-65535)`);
  }

  const password = raw.password == null || raw.password === "" ? null : String(raw.password);
  const passwordEnv = raw.password_env == null || raw.password_env === "" ? null : asScalar(raw.password_env);
  if (password && passwordEnv) {
    throw new NodeError(`${where}: give either password or password_env, not both`);
  }
  if (passwordEnv && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(passwordEnv)) {
    throw new NodeError(`${where}: password_env "${passwordEnv}" is not an environment variable name`);
  }

  const identity = raw.identity == null || raw.identity === "" ? null : expandPath(String(raw.identity));
  if (identity && password) {
    // Not an error - ssh prefers the key and only falls back to the password -
    // but it hides which one actually authenticated, so say something.
    warnings.push(`${configPath}: node "${name}": both identity and password are set; ssh will try the key first`);
  }

  // A machine belongs to one place: `group: work` is the company box,
  // `group: mine` is the one under the desk. One bucket, not a bag of tags.
  const group = (() => {
    if (raw.group == null) return null;
    const label = String(raw.group).trim();
    if (!label) return null;
    const where = `${configPath}: node "${raw.name ?? index}"`;
    if (label.length > 20) throw new NodeError(`${where}: group must be 20 characters or fewer`);
    if (!/^[A-Za-z0-9][A-Za-z0-9 ._-]*$/.test(label)) {
      throw new NodeError(`${where}: group "${label}" must be a short label (letters, digits, space, . _ -)`);
    }
    return label;
  })();

  // Tags are how a fleet stays searchable: `tags: [prod, db]` lets
  // `pp up --tag db` touch exactly the database machines.
  const tags = [];
  if (raw.tags != null) {
    const list = Array.isArray(raw.tags) ? raw.tags : String(raw.tags).split(/[,]/);
    for (const entry of list) {
      const tag = String(entry).trim();
      if (!tag) continue;
      if (!TAG_RE.test(tag)) {
        throw new NodeError(`${where}: tag "${tag}" must start with a letter or digit and use only letters, digits, ".", "_" or "-"`);
      }
      if (!tags.includes(tag)) tags.push(tag);
    }
  }

  // A guarded machine is one where stopping something should take a second
  // thought: `pp down`/`pp rm` refuse until you say --force.
  const guarded = raw.guarded === true || raw.guarded === "true" || raw.guarded === "yes";
  // A drained machine is one being worked on: its sessions are left down on
  // purpose, by people (up) and by machines (autostart, cron --heal).
  const drained = raw.drained === true || raw.drained === "true" || raw.drained === "yes";

  // `base_path` makes short session paths possible: cwd "api" on a machine
  // with base_path "/srv" means /srv/api.
  let basePath = "";
  if (raw.base_path != null && raw.base_path !== "") {
    basePath = String(asScalar(raw.base_path)).trim();
    if (!basePath.startsWith("/") && !basePath.startsWith("~")) {
      throw new NodeError(`${where}: base_path "${basePath}" must be absolute (or start with ~)`);
    }
  }

  // Per-machine defaults for the sessions that run there.
  const defaults = {};
  if (raw.defaults != null) {
    if (typeof raw.defaults !== "object" || Array.isArray(raw.defaults)) {
      throw new NodeError(`${where}: defaults must be a mapping`);
    }
    for (const [key, value] of Object.entries(raw.defaults)) {
      if (!NODE_DEFAULT_KEYS.has(key)) {
        warnings.push(`${configPath}: node "${name}": defaults.${key} is not a session setting (ignored)`);
        continue;
      }
      if (key === "restart") {
        const policy = value === true ? "always" : value === false ? "no" : String(value);
        if (!RESTART_POLICIES.includes(policy)) {
          throw new NodeError(`${where}: defaults.restart must be one of ${RESTART_POLICIES.join(", ")}`);
        }
        defaults.restart = policy;
      } else if (key === "remote_pi_mode") {
        const mode = String(value);
        if (!["config", "env", "off"].includes(mode)) {
          throw new NodeError(`${where}: defaults.remote_pi_mode must be config, env or off`);
        }
        defaults.remote_pi_mode = mode;
      } else if (key === "role") {
        // same rule as a session role: free text, short, not scheduling
        const role = value == null ? "" : String(value).trim();
        if (role.length > 24) throw new NodeError(`${where}: defaults.role must be 24 characters or fewer`);
        if (role && !/^[A-Za-z0-9][A-Za-z0-9 ._-]*$/.test(role)) {
          throw new NodeError(`${where}: defaults.role "${role}" must be a short label (letters, digits, space, . _ -)`);
        }
        if (role) defaults.role = role;
      } else if (key === "env") {
        if (value == null) continue;
        if (typeof value !== "object" || Array.isArray(value)) {
          throw new NodeError(`${where}: defaults.env must be a mapping of variables`);
        }
        const env = {};
        for (const [name, entry] of Object.entries(value)) {
          if (entry != null && typeof entry === "object") {
            throw new NodeError(`${where}: defaults.env.${name} must be a plain value`);
          }
          env[name] = entry == null ? "" : String(entry);
        }
        defaults.env = env;
      } else if (key === "args") {
        if (value == null) continue;
        // a template supplies the flags everyone on that machine wants
        // (--model, --theme); a session appends its own after them
        if (Array.isArray(value)) {
          defaults.args = value.map((entry) => String(entry));
        } else if (typeof value === "string") {
          defaults.args = value.trim().split(/\s+/).filter(Boolean);
        } else {
          throw new NodeError(`${where}: defaults.args must be a list or a string`);
        }
      } else {
        defaults.agent = value;
      }
    }
  }

  return {
    name,
    group,
    tags,
    guarded,
    drained,
    basePath,
    defaults,
    host: target.host,
    port: target.port ?? DEFAULT_PORT,
    user: target.user,
    identity,
    password,
    passwordEnv,
    note: raw.note == null ? "" : asScalar(raw.note),
  };
}

export function normalizeNodes(raw, { configPath = "<config>", warnings = [] } = {}) {
  if (raw == null) return [];
  if (!Array.isArray(raw)) throw new NodeError(`${configPath}: "nodes" must be a list`);
  const nodes = raw.map((n, i) => normalizeNode(n, i, configPath, warnings));
  const seen = new Set();
  for (const node of nodes) {
    if (seen.has(node.name)) throw new NodeError(`${configPath}: duplicate node name "${node.name}"`);
    seen.add(node.name);
  }
  return nodes;
}

/** The password for a node, from the config or from the variable it names. */
export function nodePassword(node, env = process.env) {
  if (!node) return null;
  if (node.password) return node.password;
  if (node.passwordEnv) return env[node.passwordEnv] || null;
  return null;
}

/** How a node authenticates, for tables: `key:~/x`, `pass`, `env:VAR`, `agent`. */
export function authSummary(node, env = process.env) {
  if (!node) return "-";
  if (node.identity) return `key:${node.identity.replace(homedir(), "~")}`;
  if (node.password) return "password";
  if (node.passwordEnv) return env[node.passwordEnv] ? `env:${node.passwordEnv} ✓` : `env:${node.passwordEnv} ✗`;
  return "agent";
}

/**
 * Ask a machine for its own pp config, so `pp ls` can show its sessions with the
 * rules that machine already wrote down (restart, pi session, role) instead of
 * calling them unmanaged.
 */
export const CONFIG_DUMP = [
  'cfg="$PP_PLUS_CONFIG"',
  'if [ -z "$cfg" ]; then cfg="$HOME/.pi/plus.yml"; fi',
  'if [ ! -f "$cfg" ]; then cfg="$HOME/.pi/plug.yml"; fi',
  'if [ ! -f "$cfg" ]; then cfg="$HOME/.pi/plus.yaml"; fi',
  'if [ -f "$cfg" ]; then echo "path=$cfg"; base64 -w0 < "$cfg" 2>/dev/null || base64 < "$cfg"; else echo "path="; fi',
].join("; ");

export function nodeTarget(node) {
  return node.user ? `${node.user}@${node.host}` : node.host;
}

/**
 * Build the ssh invocation for a node.
 *
 * Passwords are handed to ssh through `sshpass -e`, i.e. in the SSHPASS
 * environment variable rather than on the command line, so `ps` does not show
 * them to everyone on the box.
 */
export function sshInvocation(node, remoteCommand = [], { env = process.env, batch = true, tty = false } = {}) {
  const password = nodePassword(node, env);
  if (!password && node.passwordEnv) {
    // Falling back to a key here would hide a broken deployment: say it plainly.
    throw new NodeError(`node "${node.name}": password_env ${node.passwordEnv} is not set`);
  }
  const options = [];
  if (node.port && node.port !== DEFAULT_PORT) options.push("-p", String(node.port));
  if (node.identity) options.push("-i", node.identity);
  // 4s, not 10: a status table that waits ten seconds per unreachable machine
  // is a table nobody asks for twice. `pp node test` has its own timeout.
  options.push("-o", "ConnectTimeout=4");
  options.push("-o", "StrictHostKeyChecking=accept-new");
  if (batch && !password) options.push("-o", "BatchMode=yes");
  if (tty) options.push("-t");
  const argv = [...options, nodeTarget(node), ...remoteCommand.map(String)];
  if (!password) return { command: "ssh", argv, env: {} };
  return { command: "sshpass", argv: ["-e", "ssh", ...argv], env: { SSHPASS: password } };
}

/** What a freshly added node is asked, so `pp node test` is not a toy. */
export const PROBE_SCRIPT = [
  'echo "host=$(uname -n 2>/dev/null || hostname 2>/dev/null || echo -)"',
  'echo "os=$(uname -sr 2>/dev/null || echo -)"',
  'echo "arch=$(uname -m 2>/dev/null || echo -)"',
  'echo "tmux=$(command -v tmux >/dev/null 2>&1 && tmux -V 2>/dev/null || echo -)"',
  'echo "node=$(command -v node >/dev/null 2>&1 && node -v 2>/dev/null || echo -)"',
  'echo "pi=$(command -v pi 2>/dev/null || echo -)"',
  'echo "pp=$(command -v pp 2>/dev/null || echo -)"',
  'echo "up=$(cut -d. -f1 /proc/uptime 2>/dev/null || echo -)"',
  'echo "load=$(cut -d" " -f1-3 /proc/loadavg 2>/dev/null || echo -)"',
  'echo "sessions=$(command -v tmux >/dev/null 2>&1 && tmux ls 2>/dev/null | wc -l || echo 0)"',
  // names, not just a count: "3/4 up, 1 stray" is the sentence an operator wants
  'echo "session_names=$(command -v tmux >/dev/null 2>&1 && tmux list-sessions -F \'#{session_name}\' 2>/dev/null | tr \'\\n\' \' \' || echo)"',
  // "is this machine about to fall over" needs disk and memory, not just CPU
  'echo "disk=$(df -P / 2>/dev/null | awk \'NR==2 {print $5}\' || echo -)"',
  'echo "mem=$(awk \'/MemTotal/ {t=$2} /MemAvailable/ {a=$2} END {if (t > 0) printf "%d%%", (t-a)*100/t; else print "-"}\' /proc/meminfo 2>/dev/null || echo -)"',
].join("; ");

/** Run one command on a node and wait for it (bounded). */
export function runOnNode(node, remoteCommand, { env = process.env, batch = true, timeout = 20000, input } = {}) {
  const inv = sshInvocation(node, [], { env, batch });
  const argv = [...inv.argv, ...remoteCommand.map(String)]; // inv.argv already ends at the host
  const res = spawnSync(inv.command, argv, {
    encoding: "utf8",
    env: { ...env, ...inv.env },
    timeout,
    input,
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (res.error && res.error.code === "ENOENT") {
    throw new NodeError(
      inv.command === "sshpass"
        ? `node "${node.name}" uses a password, which needs sshpass: install it (apt install sshpass) or use identity:`
        : "ssh is not installed (or not on PATH)",
    );
  }
  if (res.error && res.error.code === "ETIMEDOUT") {
    throw new NodeError(`node "${node.name}": ssh to ${nodeTarget(node)} timed out`);
  }
  return {
    status: res.status ?? 1,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
    timedOut: Boolean(res.error && res.error.code === "ETIMEDOUT") || res.signal === "SIGTERM",
  };
}

/**
 * Same as runOnNode, but without blocking the event loop — the fleet case
 * runs every machine at once instead of one after another.
 */
export function runOnNodeAsync(node, remoteCommand, { env = process.env, batch = true, timeout = 20000 } = {}) {
  const inv = sshInvocation(node, [], { env, batch });
  const argv = [...inv.argv, ...remoteCommand.map(String)];
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(inv.command, argv, { env: { ...env, ...inv.env }, stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      resolve({ status: null, stdout: "", stderr: err.message, timedOut: false, error: err });
      return;
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
      finish({ status: null, stdout, stderr, timedOut: true });
    }, timeout);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (err) => {
      const message =
        err.code === "ENOENT"
          ? inv.command === "sshpass"
            ? `node "${node.name}" uses a password, which needs sshpass`
            : "ssh is not installed (or not on PATH)"
          : err.message;
      finish({ status: null, stdout, stderr: `${stderr}${message}`, timedOut: false, error: err });
    });
    child.on("close", (status) => {
      finish({ status: status ?? 1, stdout, stderr, timedOut: false });
    });
  });
}

/** Parse the `key=value` lines PROBE_SCRIPT prints. */
export function parseProbe(stdout) {
  const out = {};
  for (const line of String(stdout).split("\n")) {
    const at = line.indexOf("=");
    if (at <= 0) continue;
    out[line.slice(0, at)] = line.slice(at + 1).trim();
  }
  return out;
}

/** `Host` blocks from ~/.ssh/config, so `--from-ssh-config` can reuse them. */
export function parseSshConfig(text) {
  const hosts = new Map();
  let current = null;
  for (const rawLine of String(text).split("\n")) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    const match = /^([A-Za-z][A-Za-z0-9]*)\s+(.*)$/.exec(line);
    if (!match) continue;
    const key = match[1].toLowerCase();
    const value = match[2].trim().replace(/^"|"$/g, "");
    if (key === "host") {
      const names = value.split(/\s+/).filter((n) => n && !/[*?]/.test(n));
      current = names.length ? { names, host: null, port: null, user: null, identity: null } : null;
      if (current) {
        for (const name of names) {
          if (!hosts.has(name)) {
            hosts.set(name, current);
          }
        }
      }
      continue;
    }
    if (!current) continue;
    if (key === "hostname") current.host = value;
    else if (key === "port") current.port = Number(value) || null;
    else if (key === "user") current.user = value;
    else if (key === "identityfile") current.identity = value.replace(/^~(?=\/|$)/, homedir());
  }
  const out = [];
  for (const [name, entry] of hosts) {
    out.push({
      name,
      host: entry.host ?? name,
      port: entry.port ?? DEFAULT_PORT,
      user: entry.user,
      identity: entry.identity,
    });
  }
  return out;
}

const PLAIN_SCALAR = /^[A-Za-z0-9_@./\\%+,:= -]+$/;
const NEEDS_QUOTES = /^[-?:,[\]{}#&*!|>'"%@` ]|[:#] |\s$|^(?:true|false|null|yes|no|on|off|~)$|^\d+(?:\.\d+)?$/i;

export function yamlScalar(value) {
  const text = String(value);
  if (PLAIN_SCALAR.test(text) && !NEEDS_QUOTES.test(text)) return text;
  return JSON.stringify(text);
}

/** The YAML lines for one node (indented under `nodes:`). */
export function renderNodeBlock(node) {
  const lines = [`  - name: ${yamlScalar(node.name)}`, `    host: ${yamlScalar(node.host)}`];
  if (node.port && node.port !== DEFAULT_PORT) lines.push(`    port: ${node.port}`);
  if (node.user) lines.push(`    user: ${yamlScalar(node.user)}`);
  if (node.identity) lines.push(`    identity: ${yamlScalar(node.identity)}`);
  if (node.password) lines.push(`    password: ${yamlScalar(node.password)}`);
  if (node.passwordEnv) lines.push(`    password_env: ${yamlScalar(node.passwordEnv)}`);
  if (node.note) lines.push(`    note: ${yamlScalar(node.note)}`);
  if (node.group) lines.push(`    group: ${yamlScalar(node.group)}`);
  if (node.tags?.length) lines.push(`    tags: [${node.tags.join(", ")}]`);
  if (node.guarded) lines.push(`    guarded: true`);
  if (node.drained) lines.push(`    drained: true`);
  if (node.basePath) lines.push(`    base_path: ${yamlScalar(node.basePath)}`);
  const defaults = node.defaults ?? {};
  const defaultKeys = Object.keys(defaults).filter((key) => defaults[key] != null && defaults[key] !== "");
  if (defaultKeys.length) {
    lines.push("    defaults:");
    for (const key of defaultKeys) {
      if (key === "env") {
        lines.push("      env:");
        for (const [name, value] of Object.entries(defaults.env)) lines.push(`        ${name}: ${yamlScalar(value)}`);
        continue;
      }
      if (key === "args") {
        lines.push(`      args: [${defaults.args.map((entry) => yamlScalar(entry)).join(", ")}]`);
        continue;
      }
      const value = key === "agent" && Array.isArray(defaults.agent) ? defaults.agent.join(" ") : defaults[key];
      lines.push(`      ${key}: ${yamlScalar(value)}`);
    }
  }
  return lines.join("\n");
}

function findBlocks(lines, section) {
  const start = lines.findIndex((line) => new RegExp(`^${section}\\s*:`).test(line));
  if (start === -1) return null;
  const blocks = [];
  let indent = null;
  let current = null;
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^\S/.test(line)) {
      if (current) current.end = i; // the section ends here, not at EOF
      break;
    }
    const item = /^(\s*)-\s/.exec(line);
    if (item && (indent === null || item[1].length === indent)) {
      if (indent === null) indent = item[1].length;
      if (current) current.end = i;
      current = { start: i, end: lines.length, name: null };
      blocks.push(current);
    }
    if (!current) continue;
    const named = /^\s*(?:-\s*)?name\s*:\s*(.+?)\s*$/.exec(line);
    if (named && current.name === null) current.name = named[1].replace(/^['"]|['"]$/g, "");
  }
  return { start, blocks };
}

/** Insert or replace one node in the config file, keeping every other byte. */
/** Toggle one field of one node without rewriting its block by hand. */
export function setNodeField(text, name, key, value) {
  const found = findBlocks(String(text).split("\n"), "nodes");
  if (!found) return null;
  const target = found.blocks.find((entry) => entry.name === name);
  if (!target) return null;
  const lines = String(text).split("\n");
  const body = lines.slice(target.start, target.end);
  const pattern = new RegExp(`^(\\s*)(-\\s*)?${key}\\s*:`);
  let at = -1;
  for (let i = 0; i < body.length; i += 1) {
    if (pattern.test(body[i])) {
      at = i;
      break;
    }
  }
  if (value === null || value === undefined) {
    if (at === -1) return String(text);
    body.splice(at, 1);
  } else if (at !== -1) {
    const lead = pattern.exec(body[at])[1];
    const dash = /^(\s*)-\s*/.exec(body[at]);
    body[at] = `${lead}${dash ? "- " : ""}${key}: ${value}`;
  } else {
    const nameAt = body.findIndex((line) => /^\s*(?:-\s*)?name\s*:/.test(line));
    // match the indentation this block already uses, not the dash column
    let indent = "    ";
    for (const line of body.slice(1)) {
      const room = /^(\s+)\S/.exec(line);
      if (room) {
        indent = room[1];
        break;
      }
    }
    body.splice(nameAt === -1 ? body.length : nameAt + 1, 0, `${indent}${key}: ${value}`);
  }
  const next = [...lines.slice(0, target.start), ...body, ...lines.slice(target.end)];
  return `${next.join("\n").replace(/\n*$/, "")}\n`;
}

export function setNodeFieldInFile(configPath, name, key, value) {
  const path = expandPath(configPath);
  const text = readFileSync(path, "utf8");
  const next = setNodeField(text, name, key, value);
  if (next === null || next === text) return false;
  writeFileSync(path, next);
  return true;
}

export function upsertNodeInFile(configPath, node) {
  const path = expandPath(configPath);
  if (node.password) tightenConfigMode(path); // a secret is about to live here
  const text = readFileSync(path, "utf8");
  const lines = text.split("\n");
  const block = renderNodeBlock(node).split("\n");
  // `nodes: []` is an empty section, not a missing one: reuse the line.
  const emptyAt = lines.findIndex((line) => /^nodes\s*:\s*\[\s*\]\s*$/.test(line));
  if (emptyAt !== -1) lines[emptyAt] = "nodes:";
  const found = findBlocks(lines, "nodes");

  if (!found) {
    const at = lines.findIndex((line) => /^sessions\s*:/.test(line));
    const section = ["nodes:", ...block];
    const next = at === -1 ? [...lines.filter((l, i) => !(i === lines.length - 1 && l === "")), "", ...section, ""] : [...lines.slice(0, at), ...section, "", ...lines.slice(at)];
    writeFileSync(path, `${next.join("\n").replace(/\n*$/, "")}\n`);
    return "added";
  }

  const existing = found.blocks.find((entry) => entry.name === node.name);
  if (existing) {
    const next = [...lines.slice(0, existing.start), ...block, ...lines.slice(existing.end)];
    writeFileSync(path, `${next.join("\n").replace(/\n*$/, "")}\n`);
    return "updated";
  }
  const anchor = found.blocks.length ? found.blocks[found.blocks.length - 1].end : found.start + 1;
  const next = [...lines.slice(0, anchor), ...block, ...lines.slice(anchor)];
  writeFileSync(path, `${next.join("\n").replace(/\n*$/, "")}\n`);
  return "added";
}

/** Drop one node from the config file. */
export function removeNodeFromFile(configPath, name) {
  const path = expandPath(configPath);
  const text = readFileSync(path, "utf8");
  const lines = text.split("\n");
  const found = findBlocks(lines, "nodes");
  if (!found) return false;
  const target = found.blocks.find((entry) => entry.name === name);
  if (!target) return false;
  const next = [...lines.slice(0, target.start), ...lines.slice(target.end)];
  writeFileSync(path, `${next.join("\n").replace(/\n*$/, "")}\n`);
  return true;
}

/**
 * A config that carries a password is a secret file: keep it 0600 so other
 * users on the box cannot read it. Nodes with only a key or an env var do not
 * need this, and we leave the mode alone for them.
 */
export function tightenConfigMode(configPath) {
  const path = expandPath(configPath);
  if (!existsSync(path)) return false;
  try {
    chmodSync(path, 0o600);
    return true;
  } catch {
    return false;
  }
}

export { join };
