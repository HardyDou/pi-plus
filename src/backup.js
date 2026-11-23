/**
 * `pp backup` / `pp restore`: the answer to "I am about to touch the config".
 *
 * Two incidents made this necessary: a config file truncated to nineteen lines
 * by a bad edit, and a state file that a later write silently overwrote. Both
 * were recoverable only by memory. A copy costs nothing and is easy to explain
 * at 3am: it is a directory with today's time on it, holding the files pp reads.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

export const BACKUP_KEEP = 10;
export const BACKUP_FILES = ["state.json", "cron.json", "panel.json", "todos.json", "audit.log"];

/** Where backups live unless `--out` says otherwise. */
export function backupDir(env = process.env) {
  const base = env.PP_BACKUP_DIR && env.PP_BACKUP_DIR.trim() !== "" ? env.PP_BACKUP_DIR : null;
  if (base) return base;
  const state = env.XDG_STATE_HOME && env.XDG_STATE_HOME.trim() !== "" ? env.XDG_STATE_HOME : join(env.HOME || ".", ".local", "state");
  return join(state, "pi-plus", "backups");
}

/**
 * `2026-05-01T10-00-12-345` — sorts by time and is safe in a path.
 *
 * Milliseconds are not decoration: two runs inside the same second would share
 * a directory, and the second would overwrite the first. That happened — the
 * safety copy taken before a restore landed on top of the backup being
 * restored, so the restore reverted to the state that had the bug.
 */
export function stampName(now = new Date()) {
  return now.toISOString().replace(/\.(\d{3})Z$/, "-$1").replace(/[:]/g, "-");
}

/** The files worth keeping, whether or not they exist right now. */
export function backupPlan(configPath, env = process.env) {
  const state = env.XDG_STATE_HOME && env.XDG_STATE_HOME.trim() !== "" ? env.XDG_STATE_HOME : join(env.HOME || ".", ".local", "state");
  const stateFiles = BACKUP_FILES.map((name) => ({ name, path: join(state, "pi-plus", name) }));
  return [
    ...(configPath ? [{ name: "plus.yml", path: configPath }] : []),
    ...stateFiles,
  ];
}

/** Copy what exists; returns the entries that were written. */
export function writeBackup(target, plan, now = new Date()) {
  const dir = join(target, stampName(now));
  mkdirSync(dir, { recursive: true });
  const written = [];
  for (const entry of plan) {
    if (!existsSync(entry.path)) continue;
    const to = join(dir, entry.name);
    copyFileSync(entry.path, to);
    written.push({ name: entry.name, from: entry.path, to, bytes: statSync(to).size });
  }
  writeFileSync(join(dir, "manifest.json"), `${JSON.stringify({ at: now.toISOString(), files: written }, null, 2)}\n`);
  return { dir, files: written };
}

/** Oldest-first list of backup directories. */
export function listBackups(target) {
  if (!existsSync(target)) return [];
  return readdirSync(target)
    .filter((name) => /^\d{4}-\d{2}-\d{2}T/.test(name))
    .map((name) => ({ name, path: join(target, name) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Keep the newest `keep`; returns the names removed. */
export function pruneBackups(target, keep = BACKUP_KEEP) {
  const all = listBackups(target);
  if (all.length <= keep) return [];
  const doomed = all.slice(0, all.length - keep);
  for (const entry of doomed) rmSync(entry.path, { recursive: true, force: true });
  return doomed.map((entry) => entry.name);
}

/** What a directory holds, for `pp backup --list` and `pp restore --dry-run`. */
export function describeBackup(dir) {
  const manifestPath = join(dir, "manifest.json");
  if (existsSync(manifestPath)) {
    try {
      const parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
      return { at: parsed.at ?? null, files: (parsed.files ?? []).map((file) => ({ name: file.name, bytes: file.bytes })) };
    } catch {
      // a hand-edited manifest should not stop a restore
    }
  }
  const files = existsSync(dir)
    ? readdirSync(dir)
        .filter((name) => name !== "manifest.json")
        .map((name) => ({ name, bytes: statSync(join(dir, name)).size }))
    : [];
  return { at: null, files };
}

/**
 * Is this backup still whole? Backups rot: a full disk truncates a copy, a
 * prune removes a directory while the manifest stays, someone tidies a file
 * away. Listing sizes only proves what the manifest *claims*.
 */
export function verifyBackup(dir) {
  const manifestPath = join(dir, "manifest.json");
  if (!existsSync(manifestPath)) {
    return { ok: false, problems: [`${basename(dir)} has no manifest`], files: [] };
  }
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    return { ok: false, problems: [`${basename(dir)} has a manifest that does not parse (${error.message})`], files: [] };
  }
  const files = [];
  const problems = [];
  for (const file of manifest.files ?? []) {
    const path = join(dir, file.name);
    if (!existsSync(path)) {
      problems.push(`${file.name} is gone`);
      files.push({ name: file.name, ok: false, bytes: null, expected: file.bytes ?? null });
      continue;
    }
    const bytes = statSync(path).size;
    const ok = bytes === file.bytes;
    if (!ok) problems.push(`${file.name} is ${bytes} B but the manifest says ${file.bytes} B`);
    files.push({ name: file.name, ok, bytes, expected: file.bytes ?? null });
  }
  return { ok: problems.length === 0, problems, files };
}

/** Which of the backup's files still exist next to the live ones. */
export function restorePlan(configPath, backupPath, env = process.env) {
  const state = env.XDG_STATE_HOME && env.XDG_STATE_HOME.trim() !== "" ? env.XDG_STATE_HOME : join(env.HOME || ".", ".local", "state");
  const live = new Map();
  if (configPath) live.set("plus.yml", configPath);
  for (const name of BACKUP_FILES) live.set(name, join(state, "pi-plus", name));
  const { files } = describeBackup(backupPath);
  return files
    .filter((file) => live.has(file.name))
    .map((file) => ({ name: file.name, from: join(backupPath, file.name), to: live.get(file.name), bytes: file.bytes }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
