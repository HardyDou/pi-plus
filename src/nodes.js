import { spawnSync } from "node:child_process";
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
  "tags",
]);

export const DEFAULT_PORT = 22;
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

  return {
    name,
    tags,
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
  options.push("-o", "ConnectTimeout=10");
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

function yamlScalar(value) {
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
  if (node.tags?.length) lines.push(`    tags: [${node.tags.join(", ")}]`);
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
export function upsertNodeInFile(configPath, node) {
  const path = expandPath(configPath);
  if (node.password) tightenConfigMode(path); // a secret is about to live here
  const text = readFileSync(path, "utf8");
  const lines = text.split("\n");
  const block = renderNodeBlock(node).split("\n");
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
