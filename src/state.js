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
  const entries = bucket(state, configPath);
  // merge, do not replace: the same entry also tracks how long the agent has
  // been busy, and stopping something must not forget that
  entries[name] = { ...(entries[name] ?? {}), stopped: true, at: new Date().toISOString(), reason };
  writeAll(state, env);
}

/** Forget the manual stop (called whenever the session is started explicitly). */
export function clearStopped(configPath, name, env = process.env) {
  const state = readAll(env);
  const entries = bucket(state, configPath);
  const entry = entries[name];
  if (!entry?.stopped) return false;
  delete entry.stopped;
  delete entry.at;
  delete entry.reason;
  if (Object.keys(entry).length === 0) delete entries[name];
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

/**
 * Who started this session last, and why. `pp audit` already answers that for
 * the whole machine, but at 3am the question is about one session: did it come
 * back by itself (autostart, `--heal`, `--drift`) or did somebody touch it?
 */
export function markStarted(configPath, name, { why = "up", by = null } = {}, env = process.env) {
  const state = readAll(env);
  const entries = bucket(state, configPath);
  entries[name] = { ...(entries[name] ?? {}), started: { at: new Date().toISOString(), why, by } };
  writeAll(state, env);
  return entries[name].started;
}

export function startedOf(configPath, name, env = process.env) {
  return readAll(env)[configPath]?.[name]?.started ?? null;
}

/** How many restarts we keep per session: enough to see a loop, not a log. */
export const RESTART_KEEP = 5;

/**
 * A short ring of restarts, oldest first.
 *
 * `started` says when the current run began; this says whether it keeps
 * beginning. Three entries 20 minutes apart is the signature of a thrashing
 * self-heal, and that is invisible in any single snapshot.
 */
export function markRestart(configPath, name, { why = "up", by = null, at = null } = {}, env = process.env) {
  const state = readAll(env);
  const entries = bucket(state, configPath);
  const entry = entries[name] ?? {};
  const list = Array.isArray(entry.restarts) ? entry.restarts : [];
  list.push({ at: at ?? new Date().toISOString(), why, by });
  entries[name] = { ...entry, restarts: list.slice(-RESTART_KEEP) };
  writeAll(state, env);
  return entries[name].restarts;
}

export function restartsOf(configPath, name, env = process.env) {
  const list = readAll(env)[configPath]?.[name]?.restarts;
  return Array.isArray(list) ? list : [];
}

/**
 * The last time the pane actually changed while the agent was working.
 *
 * "busy for 45 minutes" is a bad alarm: a long build looks identical to a hung
 * tool call. A working agent keeps redrawing (spinner, token count, tool
 * output), so what matters is how long the screen has been *identical*. We keep
 * the signature of the last different frame and when we saw it.
 */
export function noteActivity(configPath, name, { at = new Date().toISOString(), sig = "" } = {}, env = process.env) {
  const state = readAll(env);
  const entries = bucket(state, configPath);
  entries[name] = { ...(entries[name] ?? {}), activity: { at, sig } };
  writeAll(state, env);
  return entries[name].activity;
}

export function activityOf(configPath, name, env = process.env) {
  return readAll(env)[configPath]?.[name]?.activity ?? null;
}

export function clearActivity(configPath, name, env = process.env) {
  const state = readAll(env);
  const entries = bucket(state, configPath);
  if (!entries[name] || !("activity" in entries[name])) return;
  delete entries[name].activity;
  if (!Object.keys(entries[name]).length) delete entries[name];
  writeAll(state, env);
}

/**
 * A pi session that has been "working" since yesterday is not working, it is
 * stuck (a tool call waiting on a socket, a prompt nobody answered). We only
 * know how long when we remember the first time we saw it busy, so the first
 * sighting is recorded here and the next `pp doctor` can say "busy 3h".
 */
export function markBusy(configPath, name, env = process.env, at = new Date().toISOString()) {
  const state = readAll(env);
  const entries = bucket(state, configPath);
  entries[name] = { ...(entries[name] ?? {}), busySince: at };
  writeAll(state, env);
  return at;
}

export function busySinceOf(configPath, name, env = process.env) {
  return readAll(env)[configPath]?.[name]?.busySince ?? null;
}

export function clearBusy(configPath, name, env = process.env) {
  const state = readAll(env);
  const entries = bucket(state, configPath);
  const entry = entries[name];
  if (!entry || entry.busySince === undefined) return false;
  delete entry.busySince;
  if (Object.keys(entry).length === 0) delete entries[name];
  if (Object.keys(entries).length === 0) delete state[configPath];
  writeAll(state, env);
  return true;
}
