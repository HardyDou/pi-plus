import { existsSync, readFileSync, renameSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { auditPath } from "./audit.js";
import { jobsPath } from "./cron.js";
import { panelStatePath } from "./panel.js";
import { statePath } from "./state.js";

/**
 * pp's own files, checked the way pp checks everything else.
 *
 * Every reader in this codebase swallows a parse failure on purpose — a
 * corrupt `state.json` must not stop `pp up` at 3am — but swallowing it
 * silently has a cost: the work you did (who stopped what, which jobs are due,
 * which panel to go back to) quietly disappears, and the next write makes it
 * permanent. So `pp doctor` looks at the same files and says it out loud, and
 * `pp doctor --quarantine` moves the broken one aside instead of guessing.
 */

function sizeOf(path) {
  try {
    return statSync(path).size;
  } catch {
    return null;
  }
}

function parseJsonFile(path, { expect }) {
  const text = readFileSync(path, "utf8");
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { ok: false, problem: `is not valid JSON (${error.message.replace(/^JSON\.parse: /, "")})` };
  }
  if (expect === "object" && (!parsed || typeof parsed !== "object" || Array.isArray(parsed))) {
    return { ok: false, problem: "does not contain a JSON object" };
  }
  if (expect === "list" && !Array.isArray(parsed?.jobs)) {
    return { ok: false, problem: 'does not contain a "jobs" list' };
  }
  if (expect === "list") {
    // parseable but unusable: the readers skip these, so the job silently never runs
    const broken = parsed.jobs.filter((job) => !job || typeof job !== "object" || !job.id || !job.schedule);
    if (broken.length) {
      return { ok: false, problem: `${broken.length} of ${parsed.jobs.length} job(s) have no id or schedule (they will never run)` };
    }
  }
  return { ok: true, entries: expect === "list" ? parsed.jobs.length : Object.keys(parsed).length };
}

function parseJsonLines(path) {
  const lines = readFileSync(path, "utf8").split("\n").filter((line) => line.trim());
  let bad = 0;
  for (const line of lines) {
    try {
      JSON.parse(line);
    } catch {
      bad += 1;
    }
  }
  if (bad) return { ok: false, problem: `${bad} of ${lines.length} lines are not JSON (the rest still reads)` };
  return { ok: true, entries: lines.length };
}

/** Every file pp owns, with a verdict. Missing files are not a problem. */
export function inspectStateFiles(env = process.env) {
  const targets = [
    { file: "state.json", path: statePath(env), check: (path) => parseJsonFile(path, { expect: "object" }) },
    { file: "cron.json", path: jobsPath(env), check: (path) => parseJsonFile(path, { expect: "list" }) },
    { file: "panel.json", path: panelStatePath(env), check: (path) => parseJsonFile(path, { expect: "object" }) },
    { file: "audit.log", path: auditPath(env), check: parseJsonLines },
    { file: "audit.log.1", path: `${auditPath(env)}.1`, check: parseJsonLines },
  ];
  const results = [];
  for (const target of targets) {
    if (!existsSync(target.path)) continue;
    const entry = { file: target.file, path: target.path, bytes: sizeOf(target.path) };
    try {
      const verdict = target.check(target.path);
      results.push({ ...entry, ...verdict });
    } catch (error) {
      // unreadable (permissions, a directory where a file should be)
      results.push({ ...entry, ok: false, problem: `cannot be read (${error.code ?? error.message})` });
    }
  }
  return results;
}

/** Move a broken file aside so the next write starts clean, keeping the evidence. */
export function quarantineStateFile(path, env = process.env, now = new Date()) {
  if (!existsSync(path)) return null;
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const target = `${path}.broken-${stamp}`;
  renameSync(path, target);
  return target;
}

/** One line per problem, or the healthy sentence. */
export function describeStateFiles(results, env = process.env) {
  const broken = results.filter((entry) => !entry.ok);
  if (broken.length) {
    return broken
      .map((entry) => `${entry.file} ${entry.problem} — pp doctor --quarantine moves it aside`)
      .join(" · ");
  }
  if (!results.length) return `no state files yet (${join(env.XDG_STATE_HOME || join(env.HOME || homedir(), ".local", "state"), "pi-plus")})`;
  const entries = results.reduce((sum, entry) => sum + (entry.entries ?? 0), 0);
  return `${results.length} file(s) parse, ${entries} entr${entries === 1 ? "y" : "ies"}`;
}
