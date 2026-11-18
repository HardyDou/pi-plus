// Alternate command names for people whose `pp` is already taken.
//
// macOS ships /usr/bin/pp (an ASN.1 pretty printer) and a few Linux distros
// do too, so `pp ls` can land on a binary that knows nothing about sessions.
// The package ships `pifarm` and `pi-plus` as well, and this module manages
// extra symlinks (pp alias add pif) plus the doctor check that notices when
// the name on PATH is not us.
import {
  lstatSync,
  readFileSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { expandPath } from "./config.js";
import { resolveExecutable } from "./tmux.js";

const ALIAS_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Names `npm i -g pi-farm` / install.sh create without any extra work. */
export const BUILTIN_NAMES = ["pp", "pifarm", "pi-plus"];

export class AliasError extends Error {
  constructor(message, code = "alias") {
    super(message);
    this.name = "AliasError";
    this.code = code;
  }
}

export function aliasDir(env = process.env, override = null) {
  if (override) return resolve(expandPath(override));
  if (env.PP_BIN_DIR) return resolve(expandPath(env.PP_BIN_DIR));
  return join(homedir(), ".local", "bin");
}

export function assertAliasName(name) {
  if (!name || name.startsWith("-")) {
    throw new AliasError("alias name is required, e.g. pp alias add pif", "usage");
  }
  if (!ALIAS_NAME_RE.test(name) || name === "." || name === "..") {
    throw new AliasError(
      `"${name}" is not a valid command name; use letters, digits, "-", "_" and "."`,
      "invalid_name",
    );
  }
}

function readlink(path) {
  try {
    return readlinkSync(path);
  } catch {
    return null;
  }
}

export function sameTarget(linkPath, target) {
  try {
    return realpathSync(linkPath) === realpathSync(target);
  } catch {
    return false;
  }
}

/** `{name, path, symlink, target}` or null when nothing is there. */
export function readAlias(dir, name) {
  const path = join(dir, name);
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    return null;
  }
  const symlink = stat.isSymbolicLink();
  return { name, path, symlink, target: symlink ? readlink(path) : null };
}

export function listAliases({ dir, target }) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const aliases = [];
  for (const name of entries.sort()) {
    const alias = readAlias(dir, name);
    if (!alias?.symlink) continue;
    if (target && !sameTarget(alias.path, target)) continue;
    aliases.push(alias);
  }
  return aliases;
}

export function addAlias(name, { dir, target, force = false }) {
  assertAliasName(name);
  const path = join(dir, name);
  mkdirSync(dir, { recursive: true });
  const existing = readAlias(dir, name);
  if (existing && !existing.symlink && !force) {
    throw new AliasError(`${path} already exists and is not a symlink (use --force to replace)`, "exists");
  }
  if (existing?.symlink && sameTarget(path, target)) return { path, changed: false };
  if (existing) unlinkSync(path); // a symlink (re-point) or, with --force, a real file
  symlinkSync(target, path);
  return { path, changed: true };
}

export function removeAlias(name, { dir, target }) {
  assertAliasName(name);
  const path = join(dir, name);
  const existing = readAlias(dir, name);
  if (!existing) return false;
  if (!existing.symlink) {
    throw new AliasError(`${path} is not a symlink; remove it yourself`, "not_symlink");
  }
  if (target && !sameTarget(path, target)) {
    throw new AliasError(`${path} points at ${existing.target}, not at ${target}; remove it yourself`, "foreign");
  }
  unlinkSync(path);
  return true;
}

export function dirOnPath(dir, env = process.env) {
  const wanted = (() => {
    try {
      return realpathSync(dir);
    } catch {
      return dir;
    }
  })();
  return String(env.PATH ?? "")
    .split(delimiter)
    .filter(Boolean)
    .some((entry) => {
      try {
        return realpathSync(entry) === wanted;
      } catch {
        return entry === dir;
      }
    });
}

function installedVersion(realPath) {
  try {
    const manifest = JSON.parse(readFileSync(join(dirname(dirname(realPath)), "package.json"), "utf8"));
    return typeof manifest.version === "string" ? manifest.version : null;
  } catch {
    return null;
  }
}

/**
 * Is `path` one of ours? `this` is the running script, `installed` is another
 * copy of pi-farm (npm global, ~/.local/bin) — a dev checkout running the repo
 * copy still owns the globally installed `pp`.
 */
export function installInfo(path, target) {
  let real;
  try {
    real = realpathSync(path);
  } catch {
    return null;
  }
  const version = installedVersion(real);
  if (sameTarget(path, target)) return { kind: "this", version };
  if (/(^|\/)node_modules\/pi-farm\/bin\/pp(\.js)?$/.test(real)) return { kind: "installed", version };
  return null;
}

/**
 * Which of the shipped names point at *us*? A machine can have our `pifarm`
 * on PATH and Apple's `pp` earlier in PATH at the same time.
 */
export function inspectCommandNames({ target, env = process.env, names = BUILTIN_NAMES }) {
  const resolved = names.map((name) => {
    const found = resolveExecutable(name, env);
    const path = found && found.includes("/") ? found : null;
    const info = path ? installInfo(path, target) : null;
    return { name, path, ours: Boolean(info), kind: info?.kind ?? null, version: info?.version ?? null };
  });
  return { ok: resolved.some((entry) => entry.ours), names: resolved };
}

export function describeCommandNames(info) {
  const ours = info.names.filter((entry) => entry.ours);
  const foreign = info.names.filter((entry) => entry.path && !entry.ours);
  const parts = [];
  if (ours.length > 0) {
    parts.push(
      `ours: ${ours
        .map((entry) => `${entry.name}${entry.version ? ` ${entry.version}` : ""}${entry.kind === "installed" ? " (installed)" : ""}`)
        .join(", ")}`,
    );
  }
  for (const entry of foreign) parts.push(`${entry.name} → ${entry.path} (not pi-plus)`);
  if (parts.length === 0) return "not on PATH";
  return parts.join("; ");
}
