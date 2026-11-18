import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Small state file that remembers which sessions were stopped on purpose, so
 * `restart: unless-stopped` / `on-failure` are not resurrected by autostart or
 * the `--watch` reconcile loop. Compose keeps the same information in its
 * container metadata; we keep it in XDG state.
 */
export function statePath(env = process.env) {
  const base = env.XDG_STATE_HOME || join(env.HOME || homedir(), ".local", "state");
  return join(base, "pi-plus", "state.json");
}

function readAll(env) {
  const path = statePath(env);
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeAll(state, env) {
  const path = statePath(env);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function bucket(state, configPath) {
  state[configPath] = state[configPath] && typeof state[configPath] === "object" ? state[configPath] : {};
  return state[configPath];
}

/** Record that the user stopped this session by hand. */
export function markStopped(configPath, name, env = process.env, reason = "down") {
  const state = readAll(env);
  bucket(state, configPath)[name] = { stopped: true, at: new Date().toISOString(), reason };
  writeAll(state, env);
}

/** Forget the manual stop (called whenever the session is started explicitly). */
export function clearStopped(configPath, name, env = process.env) {
  const state = readAll(env);
  const entries = bucket(state, configPath);
  if (!(name in entries)) return false;
  delete entries[name];
  if (Object.keys(entries).length === 0) delete state[configPath];
  writeAll(state, env);
  return true;
}

export function isStopped(configPath, name, env = process.env) {
  const entry = readAll(env)[configPath]?.[name];
  return Boolean(entry?.stopped);
}

export function stoppedSessions(configPath, env = process.env) {
  const entries = readAll(env)[configPath] ?? {};
  return Object.entries(entries)
    .filter(([, v]) => v?.stopped)
    .map(([name, v]) => ({ name, at: v.at, reason: v.reason }));
}
