// Self-update support for `pp update`.
//
// The CLI is distributed three ways (npm global, `install.sh` symlink into a
// git checkout, and `node bin/pp.js` from a checkout). Each one is upgraded
// differently, so first figure out *how* this copy was installed, then ask the
// registry what the newest version is, then run the matching command.
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PACKAGE_NAME = "pi-farm";
export const DEFAULT_REGISTRY = "https://registry.npmjs.org";

export class UpdateError extends Error {
  constructor(message, code = "update") {
    super(message);
    this.name = "UpdateError";
    this.code = code;
  }
}

/** `<repo|node_modules>/pi-farm` — the directory holding this package.json. */
export function packageRoot(from = import.meta.url) {
  return resolve(dirname(fileURLToPath(from)), "..");
}

export function readManifest(root = packageRoot()) {
  return JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
}

/** Numeric-aware compare; returns -1, 0 or 1. Pre-release tags are ignored. */
export function compareVersions(a, b) {
  const parse = (value) =>
    String(value ?? "")
      .split("-")[0]
      .split(".")
      .map((part) => Number.parseInt(part, 10) || 0);
  const left = parse(a);
  const right = parse(b);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const one = left[index] ?? 0;
    const other = right[index] ?? 0;
    if (one > other) return 1;
    if (one < other) return -1;
  }
  return 0;
}

export async function fetchLatestVersion({ registry = DEFAULT_REGISTRY, timeoutMs = 8000 } = {}) {
  const url = `${String(registry).replace(/\/+$/, "")}/${PACKAGE_NAME}/latest`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { accept: "application/json" } });
    if (!response.ok) throw new UpdateError(`registry answered HTTP ${response.status} for ${url}`);
    const body = await response.json();
    if (!body || typeof body.version !== "string") throw new UpdateError(`no version field in ${url}`);
    return body.version;
  } catch (error) {
    if (error instanceof UpdateError) throw error;
    const reason = error?.name === "AbortError" ? `timeout after ${timeoutMs}ms` : error?.message ?? String(error);
    throw new UpdateError(`cannot reach ${url} (${reason})`, "offline");
  } finally {
    clearTimeout(timer);
  }
}

/**
 * How was this copy installed?
 *   npm     — <prefix>/lib/node_modules/pi-farm/bin/pp.js
 *   git     — a checkout that `install.sh` symlinked (has .git next to bin/)
 *   unknown — anything else; the user has to upgrade by hand
 */
export function installKind(scriptPath, { exists = existsSync } = {}) {
  let real = scriptPath;
  try {
    real = realpathSync(scriptPath);
  } catch {
    /* keep the given path */
  }
  if (/[\\/]node_modules[\\/]pi-farm[\\/]bin[\\/]pp\.js$/.test(real)) return { kind: "npm", path: real };
  const root = dirname(dirname(real));
  if (exists(join(root, ".git")) && exists(join(root, "package.json"))) return { kind: "git", path: real, root };
  return { kind: "unknown", path: real };
}

export function isHomebrewPath(scriptPath) {
  return /[\\/](Cellar|homebrew|linuxbrew)[\\/]/.test(String(scriptPath));
}

/** The command that upgrades this copy, or null when we cannot know. */
export function planUpdate({ kind, currentVersion, latestVersion, registry = DEFAULT_REGISTRY, root, path }) {
  if (kind === "npm") {
    return {
      kind,
      command: "npm",
      args: ["i", "-g", `${PACKAGE_NAME}@${latestVersion}`, "--registry", registry],
      cwd: undefined,
      note: isHomebrewPath(path) ? "this copy looks Homebrew-managed; brew upgrade may be the right move" : undefined,
    };
  }
  if (kind === "git") {
    return { kind, command: "git", args: ["-C", root, "pull", "--ff-only"], cwd: root };
  }
  return null;
}
