import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { parseYaml, YamlError } from "./yaml.js";
import { normalizeNodes, RESTART_POLICIES, yamlScalar } from "./nodes.js";

const CONFIG_BASENAMES = ["pi-plus.yml", "pi-plus.yaml", "plus.yml", "plus.yaml"];

const TOP_LEVEL_KEYS = new Set(["version", "tmux", "defaults", "nodes", "sessions", "sort"]);
const SESSION_KEYS = new Set([
  "name",
  "cwd",
  "tmux_name",
  "agent",
  "pi",
  "pi_session",
  "pi_session_name",
  "pi_session_dir",
  "remote_pi",
  "remote_pi_name",
  "remote_pi_mode",
  "env",
  "args",
  "log",
  "remain_on_exit",
  "restart",
  "node",
  "role",
]);

/** Compose-style restart policies: when is this session brought back up? */
export { RESTART_POLICIES } from "./nodes.js";

const DEFAULT_KEYS = new Set([...SESSION_KEYS].filter((k) => k !== "name" && k !== "cwd"));

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "ConfigError";
  }
}

export const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export function expandPath(value, env = process.env, home = homedir()) {
  let out = String(value).trim();
  if (out === "~") out = home;
  else if (out.startsWith("~/")) out = join(home, out.slice(2));
  out = out.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (all, braced, bare) => {
    const key = braced ?? bare;
    return env[key] ?? all;
  });
  return out;
}

export function findConfigPath({ configPath, cwd = process.cwd(), env = process.env } = {}) {
  if (configPath) {
    const p = isAbsolute(configPath) ? configPath : resolve(cwd, configPath);
    return p;
  }
  if (env.PI_PLUS_CONFIG) {
    const p = expandPath(env.PI_PLUS_CONFIG, env);
    return isAbsolute(p) ? p : resolve(cwd, p);
  }
  for (const name of CONFIG_BASENAMES) {
    const p = resolve(cwd, name);
    if (existsSync(p)) return p;
  }
  const home = env.HOME || homedir();
  const candidates = [
    join(home, ".pi", "plus.yml"),
    join(home, ".pi", "plus.yaml"),
    join(env.XDG_CONFIG_HOME || join(home, ".config"), "pi-plus", "config.yml"),
    join(env.XDG_CONFIG_HOME || join(home, ".config"), "pi-plus", "config.yaml"),
  ];
  return candidates.find((p) => existsSync(p)) ?? null;
}

/** Split a command string shell-style (quotes + backslash), without a shell. */
export function splitCommand(input) {
  const tokens = [];
  let current = "";
  let quote = null;
  let hasToken = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else if (ch === "\\" && quote === '"' && i + 1 < input.length) {
        current += input[++i];
      } else {
        current += ch;
      }
      hasToken = true;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      hasToken = true;
    } else if (ch === "\\" && i + 1 < input.length) {
      current += input[++i];
      hasToken = true;
    } else if (/\s/.test(ch)) {
      if (hasToken) {
        tokens.push(current);
        current = "";
        hasToken = false;
      }
    } else {
      current += ch;
      hasToken = true;
    }
  }
  if (quote) throw new ConfigError(`unterminated quote in command: ${input}`);
  if (hasToken) tokens.push(current);
  return tokens;
}

function asTokens(value, field) {
  if (value == null) return [];
  if (Array.isArray(value)) return value.map((v) => String(v));
  if (typeof value === "string") return splitCommand(value);
  throw new ConfigError(`${field} must be a string or a list of strings`);
}

function asStringMap(value, field) {
  if (value == null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new ConfigError(`${field} must be a mapping of KEY: value`);
  }
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (v == null) continue;
    out[k] = String(v);
  }
  return out;
}

/** Normalize a remote-pi agent name: `<cwd>@<name>` must stay unambiguous. */
export function sanitizeRemotePiName(value) {
  if (typeof value !== "string") return null;
  const token = value
    .trim()
    .replace(/[/:@#\s]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!token) return null;
  if (token.toLowerCase() === "broadcast" || token.toLowerCase() === "broker") return null;
  return token;
}

export function isSessionPath(value) {
  const v = String(value);
  return v.startsWith("/") || v.startsWith("~/") || v.startsWith("./") || v.startsWith("../") || v.endsWith(".jsonl");
}

export function assertValidSessionId(id, where) {
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(String(id))) {
    throw new ConfigError(
      `${where}: pi_session "${id}" is not a valid pi session id ` +
        `(letters, digits, "-", "_" and "."; must start and end with a letter or digit)`,
    );
  }
}

function normalizeSession(raw, defaults, index, configPath) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConfigError(`${configPath}: sessions[${index}] must be a mapping`);
  }
  const where = `${configPath}: sessions[${index}]`;
  for (const key of Object.keys(raw)) {
    if (!SESSION_KEYS.has(key)) {
      defaults.__warnings.push(`${where}: unknown key "${key}" (ignored)`);
    }
  }

  const session = { ...defaults };
  for (const [k, v] of Object.entries(raw)) {
    if (k === "env" && v && typeof v === "object" && !Array.isArray(v)) {
      // merge, so defaults env does not leak between sessions
      session.env = { ...(defaults.env ?? {}), ...asStringMap(v, `${where}.env`) };
    } else if (k === "args" && v != null) {
      // a machine default says "--model X"; a session may add "--verbose" on
      // top of it instead of having to repeat the whole list
      const inherited = Array.isArray(defaults.args) ? defaults.args : asTokens(defaults.args, `${where}.args (inherited)`);
      session.args = [...inherited, ...asTokens(v, `${where}.args`)];
    } else {
      session[k] = v;
    }
  }

  const name = String(session.name ?? "").trim();
  if (!name) throw new ConfigError(`${where}: "name" is required`);
  if (!NAME_RE.test(name)) {
    throw new ConfigError(
      `${where}: name "${name}" is not tmux-safe; use letters, digits, "-" and "_" ` +
        `(tmux reserves "." and ":" for targets)`,
    );
  }

  const cwdRaw = session.cwd == null ? process.cwd() : String(session.cwd);
  const cwd = resolve(expandPath(cwdRaw));
  if (!isAbsolute(cwd)) throw new ConfigError(`${where}: cwd must resolve to an absolute path`);

  const agent = asTokens(session.agent ?? "pi", `${where}.agent`);
  if (agent.length === 0) throw new ConfigError(`${where}: agent command is empty`);

  const piRequested = session.pi;
  const pi = piRequested === undefined || piRequested === null ? basename(agent[0]) === "pi" : Boolean(piRequested);

  const piSessionDir =
    session.pi_session_dir === undefined || session.pi_session_dir === null || session.pi_session_dir === ""
      ? null
      : resolve(expandPath(String(session.pi_session_dir)));

  const piSessionRaw = session.pi_session == null ? null : String(session.pi_session).trim();
  let piSession = piSessionRaw || null;
  if (piSession) {
    if (isSessionPath(piSession)) {
      piSession = resolve(expandPath(piSession));
    } else {
      assertValidSessionId(piSession, where);
    }
  }

  const piSessionNameRaw =
    session.pi_session_name === undefined ? name : session.pi_session_name;
  const piSessionName = piSessionNameRaw == null ? null : String(piSessionNameRaw).trim() || null;

  const rp = session.remote_pi && typeof session.remote_pi === "object" && !Array.isArray(session.remote_pi)
    ? session.remote_pi
    : {};
  const rpNameRaw =
    rp.name !== undefined ? rp.name
      : session.remote_pi_name !== undefined ? session.remote_pi_name
        : name;
  let remotePiName = null;
  if (rpNameRaw !== false && rpNameRaw !== null && rpNameRaw !== undefined) {
    const sanitized = sanitizeRemotePiName(String(rpNameRaw));
    if (!sanitized) {
      throw new ConfigError(`${where}: remote_pi_name "${rpNameRaw}" is not a usable agent name`);
    }
    remotePiName = sanitized;
  }

  // A remote session cannot write its name into the node's working directory,
  // so "env" is the sensible default there — and saying so should not be a
  // warning on every single remote session.
  const modeDefault = session.node ? "env" : "config";
  const modeGiven = rp.mode !== undefined || session.remote_pi_mode !== undefined;
  const mode = String(rp.mode ?? session.remote_pi_mode ?? modeDefault).toLowerCase();
  if (!["config", "env", "off"].includes(mode)) {
    throw new ConfigError(`${where}: remote_pi_mode must be "config", "env" or "off"`);
  }

  const restartRaw = session.restart ?? "always";
  let restart;
  if (restartRaw === true) restart = "always";
  else if (restartRaw === false) restart = "no";
  else restart = String(restartRaw).trim().toLowerCase();
  if (!RESTART_POLICIES.includes(restart)) {
    throw new ConfigError(
      `${where}: restart must be one of ${RESTART_POLICIES.join(", ")} (got "${restartRaw}")`,
    );
  }

  const nodeRaw = session.node == null ? null : String(session.node).trim();
  if (nodeRaw !== null && nodeRaw === "") {
    throw new ConfigError(`${where}: node must name a machine from "nodes"`);
  }

  return {
    name,
    node: nodeRaw,
    tmuxName: String(session.tmux_name ?? name).trim() || name,
    cwd,
    agent,
    pi,
    piSession,
    piSessionDir,
    piSessionName,
    remotePiName,
    remotePiMode: mode,
    remotePiModeGiven: modeGiven,
    // a machine can carry a default label (nodes[].defaults.role): "everything on
    // the test box is `test`" should not need a line per session. An explicit
    // `role:` in the session wins, including an empty one, which clears it.
    role: roleOf(
      Object.prototype.hasOwnProperty.call(session, "role") ? session.role : defaults.role,
      where,
    ),
    env: asStringMap(session.env, `${where}.env`),
    args: asTokens(session.args, `${where}.args`),
    log: session.log === true ? join(cwd, ".pi-plus.log") : session.log ? resolve(expandPath(String(session.log))) : null,
    // Compose keeps an exited container around for `logs`/`ps`; do the same for
    // restart: no so a crashed session can be inspected instead of vanishing.
    remainOnExit: Boolean(session.remain_on_exit ?? false) || restart === "no",
    restart,
  };
}

/** `/srv`, `~/x`, `./x`, `..` are paths; `api` alone is a path relative to the node. */
function isAbsolutePath(value) {
  const text = String(value).trim();
  return text.startsWith("/") || text.startsWith("~") || text.startsWith("./") || text.startsWith("../") || text === "." || text === "..";
}

/**
 * A session's role is a label for humans ("what is this one for?"), free text,
 * deliberately not wired into scheduling decisions.
 */
function roleOf(value, where) {
  if (value === undefined || value === null || value === "") return null;
  const role = String(value).trim();
  if (role === "") return null;
  if (role.length > 24) throw new ConfigError(`${where}.role must be 24 characters or fewer`);
  if (!/^[A-Za-z0-9][A-Za-z0-9 ._-]*$/.test(role)) {
    throw new ConfigError(`${where}.role "${role}" must be a short label (letters, digits, space, . _ -)`);
  }
  return role;
}

export function normalizeConfig(raw, { configPath = "<config>" } = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConfigError(`${configPath}: config root must be a mapping`);
  }
  const warnings = [];
  for (const key of Object.keys(raw)) {
    if (!TOP_LEVEL_KEYS.has(key)) warnings.push(`${configPath}: unknown top-level key "${key}" (ignored)`);
  }

  const tmux = raw.tmux && typeof raw.tmux === "object" ? raw.tmux : {};
  const defaultsRaw = raw.defaults && typeof raw.defaults === "object" ? raw.defaults : {};
  for (const key of Object.keys(defaultsRaw)) {
    if (!DEFAULT_KEYS.has(key)) warnings.push(`${configPath}: unknown defaults key "${key}" (ignored)`);
  }

  const defaults = {
    name: undefined,
    cwd: undefined,
    tmux_name: undefined,
    ...defaultsRaw,
    env: asStringMap(defaultsRaw.env, `${configPath}: defaults.env`),
    args: asTokens(defaultsRaw.args, `${configPath}: defaults.args`),
    __warnings: warnings,
  };

  const nodes = normalizeNodes(raw.nodes, { configPath, warnings });

  if (!Array.isArray(raw.sessions)) {
    throw new ConfigError(`${configPath}: "sessions" must be a list`);
  }
  // A machine can carry its own defaults ("everything on t114 runs in /srv with
  // restart: no") so a session entry only has to say what makes it different.
  const nodesByName = new Map(nodes.map((node) => [node.name, node]));
  const sessions = raw.sessions.map((s, i) => {
    const nodeName = typeof s?.node === "string" && s.node.trim() !== "" ? s.node.trim() : null;
    const node = nodeName ? nodesByName.get(nodeName) : null;
    if (!node) return normalizeSession(s, defaults, i, configPath);
    // env merges (top level -> machine -> session), args stack (machine first)
    const nodeDefaults = {
      ...defaults,
      ...(node.defaults ?? {}),
      ...(defaults.env || node.defaults?.env
        ? { env: { ...(defaults.env ?? {}), ...(node.defaults?.env ?? {}) } }
        : {}),
    };
    const merged = { ...s };
    if (node.basePath && typeof merged.cwd === "string" && merged.cwd !== "" && !isAbsolutePath(merged.cwd)) {
      // a relative cwd is relative to the machine's base path, not to whoever
      // happened to run pp
      merged.cwd = join(node.basePath, merged.cwd);
    }
    return normalizeSession(merged, nodeDefaults, i, configPath);
  });

  const nodeNames = new Set(nodes.map((n) => n.name));
  for (const s of sessions) {
    if (!s.node) continue;
    if (!nodeNames.has(s.node)) {
      throw new ConfigError(
        `${configPath}: session "${s.name}": node "${s.node}" is not defined under "nodes"` +
          (nodeNames.size ? ` (known: ${[...nodeNames].join(", ")})` : " (there are no nodes yet — pp node add)"),
      );
    }
    if (s.remotePiMode === "config" && s.remotePiModeGiven) {
      // The remote-pi name would have to be written into the *remote* working
      // directory; pp cannot do that yet, so fall back to the env mode.
      warnings.push(
        `${configPath}: session "${s.name}" runs on node "${s.node}": remote_pi_mode "config" is not supported ` +
          `for remote sessions, using "env"`,
      );
      s.remotePiMode = "env";
    }
  }

  const seenTmux = new Map();
  for (const s of sessions) {
    if (seenTmux.has(s.tmuxName)) {
      throw new ConfigError(
        `${configPath}: duplicate tmux session name "${s.tmuxName}" (used by "${seenTmux.get(s.tmuxName)}" and "${s.name}")`,
      );
    }
    seenTmux.set(s.tmuxName, s.name);
  }

  const byCwd = new Map();
  for (const s of sessions) {
    // Only "config" mode is affected: it writes agent_name into the shared per-directory file.
    if (!s.remotePiName || s.remotePiMode !== "config") continue;
    const list = byCwd.get(s.cwd) ?? [];
    list.push(s);
    byCwd.set(s.cwd, list);
  }
  for (const [cwd, list] of byCwd) {
    const names = new Set(list.map((s) => s.remotePiName));
    if (names.size > 1) {
      warnings.push(
        `${configPath}: sessions ${list.map((s) => `"${s.name}"`).join(", ")} share cwd ${cwd} ` +
          `but request different remote-pi names (${[...names].map((n) => `"${n}"`).join(", ")}). ` +
          `remote-pi stores agent_name per directory, so the last write wins — ` +
          `use remote_pi_mode: env to give each session its own name.`,
      );
    }
  }

  // `sort: name` lets a machine default to "related sessions next to each
  // other" without every command line saying so.
  const SORT_CHOICES = new Set(["config", "idle", "name", "role"]);
  let sort = "config";
  if (raw.sort !== undefined && raw.sort !== null) {
    const value = String(raw.sort).trim().toLowerCase();
    if (!SORT_CHOICES.has(value)) {
      throw new ConfigError(`${configPath}: sort "${raw.sort}" must be one of ${[...SORT_CHOICES].join(", ")}`);
    }
    sort = value;
  }

  return {
    path: configPath,
    version: raw.version ?? 1,
    tmuxSocket: tmux.socket ? String(tmux.socket) : null,
    sort,
    nodes,
    sessions,
    warnings,
  };
}

/**
 * Cut one `sessions:` entry out of a YAML document, leaving every other byte
 * alone (comments, ordering, quoting). Returns `{ text, removed }`; `removed`
 * is false when the name is not there, so callers can say so.
 */
/**
 * Locate the `sessions:` list items: { start, end, name, indent } per block.
 * `end` is either the next item's line or the first line after the section —
 * never `lines.length`, which used to make every caller truncate the file.
 */
export function findSessionBlocks(text) {
  const lines = String(text).split("\n");
  const sectionStart = lines.findIndex((line) => /^sessions\s*:/.test(line));
  if (sectionStart === -1 || /^sessions\s*:\s*\[\s*\]\s*$/.test(lines[sectionStart])) return { lines, blocks: [] };

  const blocks = [];
  let indent = null;
  let current = null;
  for (let i = sectionStart + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^\S/.test(line)) {
      if (current) current.end = i; // the section ends here, not at EOF
      break;
    } // next top-level key ends the section
    const item = /^(\s*)-\s/.exec(line);
    if (item && (indent === null || item[1].length === indent)) {
      if (indent === null) indent = item[1].length;
      if (current) current.end = i;
      current = { start: i, end: lines.length, name: null, indent: item[1].length + 2 };
      blocks.push(current);
    }
    if (!current) continue;
    const named = /^\s*(?:-\s*)?name\s*:\s*(.+?)\s*$/.exec(line);
    if (named && current.name === null) current.name = named[1].replace(/^['"]|['"]$/g, "");
  }
  return { lines, blocks };
}

/**
 * Set (or with `null` delete) one field of one session, touching nothing else.
 * Returns the new text, or null when that session is not in the file.
 */
export function setSessionField(text, name, key, value) {
  const { lines, blocks } = findSessionBlocks(text);
  const target = blocks.find((entry) => entry.name === name);
  if (!target) return null;
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
    const leadIndent = pattern.exec(body[at])[1];
    const dash = /^(\s*)-\s*/.exec(body[at]);
    body[at] = `${leadIndent}${dash ? "- " : ""}${key}: ${value}`;
  } else {
    // put it right after `name:` so the block reads in the usual order
    const nameAt = body.findIndex((line) => /^\s*(?:-\s*)?name\s*:/.test(line));
    const indent = " ".repeat(target.indent);
    body.splice(nameAt === -1 ? body.length : nameAt + 1, 0, `${indent}${key}: ${value}`);
  }
  const next = [...lines.slice(0, target.start), ...body, ...lines.slice(target.end)];
  return `${next.join("\n").replace(/\n*$/, "")}\n`;
}

/** One YAML item for a session, the shape `pp new --save` writes. */
export function renderSessionEntry(session) {
  return [
    `  - name: ${session.name}`,
    `    cwd: ${session.cwd}`,
    session.node ? `    node: ${session.node}` : null,
    session.role ? `    role: ${session.role}` : null,
    session.agent ? `    agent: ${session.agent}` : null,
    // "no" is a YAML boolean, so the one policy that collides gets quotes
    `    restart: ${(session.restart ?? "unless-stopped") === "no" ? '"no"' : (session.restart ?? "unless-stopped")}`,
    session.env && Object.keys(session.env).length
      ? `    env:\n${Object.entries(session.env)
          .map(([key, value]) => `      ${key}: ${yamlScalar(String(value))}`)
          .join("\n")}`
      : null,
    session.args && session.args.length ? `    args: [${session.args.map((arg) => yamlScalar(String(arg))).join(", ")}]` : null,
    session.log ? `    log: ${session.log}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Append a session to the end of the `sessions:` list — after the last item,
 * not at the end of the file, so a `nodes:` section below it stays readable.
 */
export function appendSessionBlock(text, entry) {
  let source = String(text);
  if (/^sessions:\s*\[\s*\]\s*$/m.test(source)) source = source.replace(/^sessions:\s*\[\s*\]\s*$/m, "sessions:");
  if (!/^sessions\s*:/m.test(source)) return null;
  const { lines, blocks } = findSessionBlocks(source);
  const at = blocks.length ? blocks[blocks.length - 1].end : lines.findIndex((line) => /^sessions\s*:/.test(line)) + 1;
  const next = [...lines.slice(0, at), ...entry.split("\n"), ...lines.slice(at)];
  return `${next.join("\n").replace(/\n*$/, "")}\n`;
}

/** Append a session to a config file on disk. */
export function appendSessionToFile(configPath, entry) {
  const path = expandPath(configPath);
  const next = appendSessionBlock(readFileSync(path, "utf8"), entry);
  if (next === null) return false;
  writeFileSync(path, next);
  return true;
}

/** Rewrite one field of one session on disk. Returns true when it changed. */
export function setSessionFieldInFile(configPath, name, key, value) {
  const path = expandPath(configPath);
  const text = readFileSync(path, "utf8");
  const next = setSessionField(text, name, key, value);
  if (next === null || next === text) return false;
  writeFileSync(path, next);
  return true;
}

export function removeSessionBlock(text, name) {
  const { lines, blocks } = findSessionBlocks(text);
  const target = blocks.find((entry) => entry.name === name);
  if (!target) return { text: String(text), removed: false };

  const rest = lines.slice();
  rest.splice(target.start, target.end - target.start);
  const cleaned = [];
  for (const line of rest) {
    if (line.trim() === "" && cleaned.length && cleaned[cleaned.length - 1].trim() === "") continue;
    cleaned.push(line);
  }
  if (cleaned.length && cleaned[cleaned.length - 1].trim() === "" && cleaned.length > 1) cleaned.pop();
  // removing the last session leaves a bare `sessions:` behind, which parses as
  // null and then fails as "must be a list" on the next command
  const header = cleaned.findIndex((line) => /^sessions\s*:/.test(line));
  if (header >= 0) {
    // only look inside this section: the next top-level key starts another one
    const section = [];
    for (const line of cleaned.slice(header + 1)) {
      if (/^\S/.test(line)) break;
      section.push(line);
    }
    const hasItems = section.some((line) => /^(\s*)-\s/.test(line));
    if (!hasItems) cleaned[header] = `${cleaned[header].replace(/\s*:\s*$/, "")}: []`;
  }
  return { text: `${cleaned.join("\n").replace(/\n*$/, "")}\n`, removed: true };
}

/** Rewrite a config file without the given session. Returns the new text or null. */
export function removeSessionFromFile(configPath, name) {
  const text = readFileSync(expandPath(configPath), "utf8");
  const result = removeSessionBlock(text, name);
  if (!result.removed) return null;
  writeFileSync(expandPath(configPath), result.text);
  return result.text;
}

export function loadConfigFile(configPath) {
  let text;
  try {
    text = readFileSync(configPath, "utf8");
  } catch (err) {
    throw new ConfigError(`cannot read config ${configPath}: ${err.message}`);
  }
  let raw;
  try {
    raw = parseYaml(text);
  } catch (err) {
    if (err instanceof YamlError) throw new ConfigError(`${configPath}: ${err.message}`);
    throw err;
  }
  return normalizeConfig(raw, { configPath });
}

export function loadConfig(options = {}) {
  const configPath = findConfigPath(options);
  if (!configPath) return null;
  if (!existsSync(configPath)) {
    throw new ConfigError(`config file not found: ${configPath}`);
  }
  return loadConfigFile(configPath);
}

/** The argv pp hands to tmux (after `env KEY=VALUE ...` when env is set). */
export function buildSessionArgv(session) {
  const argv = [...session.agent];
  if (session.pi) {
    if (session.piSessionName) argv.push("--name", session.piSessionName);
    if (session.piSessionDir) argv.push("--session-dir", session.piSessionDir);
    if (session.piSession) {
      argv.push(isSessionPath(session.piSession) ? "--session" : "--session-id", session.piSession);
    }
  }
  argv.push(...session.args);
  return argv;
}

/**
 * Resolve a session reference from the CLI: exact name/tmux name first, then a
 * 1-based index in config order (the `#` column from `pp ls`).
 */
export function resolveSessionRef(config, ref) {
  const value = String(ref);
  const exact = config.sessions.find((s) => s.name === value || s.tmuxName === value);
  if (exact) return exact;
  if (!/^\d+$/.test(value)) return null;
  const index = Number(value);
  return index >= 1 && index <= config.sessions.length ? config.sessions[index - 1] : null;
}

export function shellQuote(value) {
  const v = String(value);
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(v)) return v;
  return `'${v.replace(/'/g, `'\\''`)}'`;
}

export function describeSession(session) {
  const parts = buildSessionArgv(session).map(shellQuote);
  const env = Object.entries(session.env).map(([k, v]) => `${k}=${shellQuote(v)}`);
  return [...(env.length ? ["env", ...env] : []), ...parts].join(" ");
}

export { basename, dirname, resolve };
