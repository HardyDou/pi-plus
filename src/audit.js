/**
 * Append-only trail of everything `pp` changes on this machine.
 *
 * The question this answers is the one asked at 3am with no memory of the
 * previous evening: "who stopped this session, and when?". One JSON object per
 * line in `$XDG_STATE_HOME/pi-plus/audit.log`, rotated at 2 MB so a long-lived
 * machine cannot fill a disk with history.
 *
 * Nothing here may throw: an audit trail that breaks the command it describes
 * gets switched off by the first person who hits it.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { hostname, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export const MAX_BYTES = 2 * 1024 * 1024;

/** `~/.local/state/pi-plus` (override with XDG_STATE_HOME). */
export function stateDir(env = process.env) {
  const base = env.XDG_STATE_HOME && env.XDG_STATE_HOME.trim() !== "" ? env.XDG_STATE_HOME : join(env.HOME || homedir(), ".local", "state");
  return join(base, "pi-plus");
}

/** Where the trail lives (`PP_AUDIT_FILE` wins). */
export function auditPath(env = process.env) {
  return env.PP_AUDIT_FILE && env.PP_AUDIT_FILE.trim() !== "" ? env.PP_AUDIT_FILE : join(stateDir(env), "audit.log");
}

/** `user@host` — enough to tell a cron tick from a person on a laptop. */
export function auditActor(env = process.env, pid = process.pid) {
  let user = env.USER || env.LOGNAME || "";
  if (!user) {
    try {
      user = userInfo().username;
    } catch {
      user = "someone";
    }
  }
  let host = "";
  try {
    host = hostname();
  } catch {
    host = "localhost";
  }
  return `${user}@${host}#${pid}`;
}

function rotate(path) {
  try {
    if (existsSync(path) && statSync(path).size > MAX_BYTES) renameSync(path, `${path}.1`);
  } catch {
    /* rotation is best effort */
  }
}

/**
 * Write one entry. `action` is a verb the operator would say out loud
 * ("down", "send", "cron.add"), `target` what it happened to.
 */
export function recordAudit({ action, target = null, node = null, detail = null, result = null, extra = null } = {}, env = process.env) {
  try {
    const path = auditPath(env);
    mkdirSync(dirname(path), { recursive: true });
    rotate(path);
    const entry = {
      ts: new Date().toISOString(),
      actor: auditActor(env),
      action: String(action ?? "unknown"),
      target: target == null ? null : String(target),
      node: node == null || node === "" ? null : String(node),
      detail: detail == null ? null : String(detail),
      result: result == null ? null : String(result),
      ...(extra && typeof extra === "object" ? extra : null),
    };
    appendFileSync(path, `${JSON.stringify(entry)}\n`, "utf8");
    return true;
  } catch {
    return false;
  }
}

/** Read the trail, newest last. Filters are exact matches on `action`/`target` plus a `since` cutoff. */
export function readAudit({ limit = 40, action = null, target = null, actor = null, since = null, file = null } = {}, env = process.env) {
  const path = file ?? auditPath(env);
  if (!existsSync(path)) return [];
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const entries = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // a half-written line is not worth failing over
    }
    if (!entry || typeof entry !== "object") continue;
    if (action && entry.action !== action) continue;
    if (target && entry.target !== target && entry.node !== target) continue;
    // `--actor bob` should match bob@host#1234 without anyone typing the rest
    if (actor && !String(entry.actor ?? "").startsWith(actor)) continue;
    if (since && Date.parse(entry.ts ?? "") < since.getTime()) continue;
    entries.push(entry);
  }
  const sliced = limit > 0 ? entries.slice(-limit) : entries;
  return sliced;
}

/** Drop entries older than the cutoff, in place. Returns how many were kept. */
export function pruneAudit({ olderThan = new Date(0), file = null } = {}, env = process.env) {
  const path = file ?? auditPath(env);
  if (!existsSync(path)) return { kept: 0, dropped: 0 };
  let kept = 0;
  let dropped = 0;
  const keptLines = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    let entry = null;
    try {
      entry = JSON.parse(line);
    } catch {
      dropped++; // unparseable lines are noise from an old bug
      continue;
    }
    const when = Date.parse(entry?.ts ?? "");
    if (Number.isFinite(when) && when < olderThan.getTime()) {
      dropped++;
      continue;
    }
    kept++;
    keptLines.push(line);
  }
  try {
    writeFileSync(`${path}.tmp`, keptLines.length ? `${keptLines.join("\n")}\n` : "", "utf8");
    renameSync(`${path}.tmp`, path);
  } catch {
    return { kept, dropped: 0 };
  }
  return { kept, dropped };
}

/** "2m ago" — the only time format people read at 3am. */
export function agoText(iso, now = new Date()) {
  const when = Date.parse(iso ?? "");
  if (!Number.isFinite(when)) return "?";
  const seconds = Math.max(0, Math.round((now.getTime() - when) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** One line per entry: `when action target detail (result) [node]`. */
export function formatAuditEntry(entry, now = new Date()) {
  const parts = [agoText(entry.ts, now).padEnd(8), String(entry.action ?? "?").padEnd(12), String(entry.target ?? "-")];
  if (entry.node) parts.push(`on ${entry.node}`);
  if (entry.detail) parts.push(`— ${entry.detail}`);
  if (entry.result) parts.push(`(${entry.result})`);
  return parts.join(" ").replace(/\s+$/, "");
}
