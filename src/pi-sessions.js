import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Where pi keeps the conversations of one directory.
 *
 * pi slugifies the cwd (`/data/work` -> `--data-work--`) and names each file
 * `<timestamp>_<session-id>.jsonl`; the id itself is on the first line.
 */
export function sessionDirFor(cwd, env = process.env) {
  const home = env.HOME || homedir();
  const clean = String(cwd).replace(/^\/+/, "").replace(/\/+$/, "");
  const slug = `--${clean.replace(/\//g, "-")}--`;
  return join(home, ".pi", "agent", "sessions", slug);
}

function readId(path) {
  try {
    const head = readFileSync(path, { encoding: "utf8", flag: "r" }).slice(0, 2000);
    const first = head.split("\n")[0];
    const parsed = JSON.parse(first);
    if (parsed?.type === "session" && typeof parsed.id === "string") return parsed.id;
  } catch {
    // a half-written or hand-edited file: not a candidate
  }
  return null;
}

/** Conversations pi has on disk for this directory, newest first. */
export function listPiSessions(cwd, env = process.env, { withNames = false } = {}) {
  const dir = sessionDirFor(cwd, env);
  if (!existsSync(dir)) return { dir, sessions: [] };
  const sessions = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".jsonl")) continue;
    const path = join(dir, name);
    let stats;
    try {
      stats = statSync(path);
    } catch {
      continue;
    }
    const id = readId(path);
    if (!id) continue;
    sessions.push({
      id,
      name,
      path,
      bytes: stats.size,
      modified: stats.mtimeMs,
      ...(withNames ? { displayName: sessionNameOf(path) } : {}),
    });
  }
  sessions.sort((a, b) => b.modified - a.modified);
  return { dir, sessions };
}

/**
 * The display name pi last recorded for a conversation (`--name` is kept as a
 * `session_info` event, not on the first line). Scans the file; the name may
 * have been set minutes or hours after the session started.
 */
export function sessionNameOf(path, { limitBytes = 128 * 1024 * 1024 } = {}) {
  try {
    if (statSync(path).size > limitBytes) return null;
    const text = readFileSync(path, "utf8");
    let name = null;
    const pattern = /"type":"session_info"[^}]*?"name":"((?:[^"\\]|\\.)*)"/g;
    for (const match of text.matchAll(pattern)) name = match[1];
    return name;
  } catch {
    return null;
  }
}

/** `2h ago` for a millisecond timestamp, without pulling in the whole clock. */
export function ageOf(modified, now = Date.now()) {
  const seconds = Math.max(0, Math.round((now - modified) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86400)}d ago`;
}
