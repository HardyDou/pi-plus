import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync, openSync, closeSync, statSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

/**
 * Scheduled prompts.
 *
 * A job is a message that is typed into a tmux session at a point in time —
 * the same keystrokes `pp send` produces, so the agent on the other side sees a
 * normal user message. Nothing here runs an agent on its own; the pi process
 * already living in that pane does the work.
 *
 * Three schedule shapes: one-shot (`at`), fixed interval (`every`), and a
 * five-field cron expression (`cron`), which is what "every 5 minutes" and
 * "Monday, Tuesday, Wednesday at 9" turn into.
 */

export const DEFAULT_CATCH_UP_SECONDS = 7200;
const LOCK_STALE_MS = 10 * 60 * 1000;

const DOW_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const MONTH_NAMES = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

const CRON_MACROS = {
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
  "@monthly": "0 0 1 * *",
  "@weekly": "0 0 * * 0",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@hourly": "0 * * * *",
};

export class CronError extends Error {
  constructor(message, code = "cron") {
    super(message);
    this.name = "CronError";
    this.code = code;
  }
}

/** `~/.local/state/pi-plus/cron.json` (override with XDG_STATE_HOME). */
export function jobsPath(env = process.env) {
  const base = env.XDG_STATE_HOME || join(env.HOME || homedir(), ".local", "state");
  return join(base, "pi-plus", "cron.json");
}

export function cronLogPath(env = process.env) {
  const base = env.XDG_STATE_HOME || join(env.HOME || homedir(), ".local", "state");
  return join(base, "pi-plus", "cron.log");
}

function lockPath(env = process.env) {
  return `${jobsPath(env)}.lock`;
}

// ---------------------------------------------------------------- cron syntax

function normaliseToken(token, { names = null, min, max, dow = false } = {}) {
  const lowered = String(token).trim().toLowerCase();
  if (!lowered) throw new CronError("empty value in cron expression");
  let value;
  if (/^\d+$/.test(lowered)) value = Number(lowered);
  else if (names && names.includes(lowered)) value = names.indexOf(lowered) + (names === DOW_NAMES ? 0 : 1);
  else throw new CronError(`"${token}" is not a valid value here`);

  if (dow && value === 7) return 0; // 7 and 0 are both Sunday
  if (value < min || value > max) {
    throw new CronError(`${value} is out of range for this field (${min}-${max})`);
  }
  return value;
}

function parseField(spec, { min, max, names = null, dow = false } = {}) {
  const values = new Set();
  for (const part of String(spec).split(",")) {
    const chunk = part.trim();
    if (!chunk) throw new CronError(`empty value in "${spec}"`);
    const [range, stepText] = chunk.split("/");
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1) throw new CronError(`"${chunk}" has a bad step`);

    let from;
    let to;
    if (range === "*") {
      from = min;
      to = max;
    } else if (range.includes("-")) {
      const [a, b] = range.split("-");
      from = normaliseToken(a, { names, min, max, dow });
      to = normaliseToken(b, { names, min, max, dow });
      if (from > to) throw new CronError(`"${range}" is a backwards range`);
    } else {
      from = normaliseToken(range, { names, min, max, dow });
      to = stepText === undefined ? from : max;
    }
    for (let value = from; value <= to; value += step) values.add(value);
  }
  return values;
}

/**
 * Parse a five-field cron expression (plus `@hourly`-style macros) into sets.
 * Day-of-month and day-of-week follow the classic rule: when both are
 * restricted, a date matches if *either* does.
 */
export function parseCron(expression) {
  const text = String(expression).trim().replace(/\s+/g, " ");
  const expanded = CRON_MACROS[text.toLowerCase()] ?? text;
  const fields = expanded.split(" ");
  if (fields.length !== 5) {
    throw new CronError(`"${expression}" is not a cron expression (expected: minute hour day month weekday)`);
  }
  const [minuteSpec, hourSpec, domSpec, monthSpec, dowSpec] = fields;
  return {
    source: text,
    minutes: parseField(minuteSpec, { min: 0, max: 59 }),
    hours: parseField(hourSpec, { min: 0, max: 23 }),
    doms: parseField(domSpec, { min: 1, max: 31 }),
    months: parseField(monthSpec, { min: 1, max: 12, names: MONTH_NAMES }),
    dows: parseField(dowSpec, { min: 0, max: 6, names: DOW_NAMES, dow: true }),
    domRestricted: domSpec.trim() !== "*",
    dowRestricted: dowSpec.trim() !== "*",
  };
}

export function cronMatches(parsed, date) {
  if (!parsed.minutes.has(date.getMinutes())) return false;
  if (!parsed.hours.has(date.getHours())) return false;
  if (!parsed.months.has(date.getMonth() + 1)) return false;
  const domHit = parsed.doms.has(date.getDate());
  const dowHit = parsed.dows.has(date.getDay());
  if (parsed.domRestricted && parsed.dowRestricted) return domHit || dowHit;
  return domHit && dowHit;
}

/** First matching minute strictly after `from` (local time), or null. */
export function nextCronRun(parsed, from = new Date()) {
  const cursor = new Date(from.getTime());
  cursor.setSeconds(0, 0);
  cursor.setMinutes(cursor.getMinutes() + 1);
  const limit = new Date(from.getTime());
  limit.setDate(limit.getDate() + 366);

  while (cursor <= limit) {
    if (!parsed.months.has(cursor.getMonth() + 1)) {
      cursor.setMonth(cursor.getMonth() + 1, 1);
      cursor.setHours(0, 0, 0, 0);
      continue;
    }
    const domHit = parsed.doms.has(cursor.getDate());
    const dowHit = parsed.dows.has(cursor.getDay());
    const dayHit = parsed.domRestricted && parsed.dowRestricted ? domHit || dowHit : domHit && dowHit;
    if (!dayHit) {
      cursor.setDate(cursor.getDate() + 1);
      cursor.setHours(0, 0, 0, 0);
      continue;
    }
    if (!parsed.hours.has(cursor.getHours())) {
      cursor.setHours(cursor.getHours() + 1, 0, 0, 0);
      continue;
    }
    if (!parsed.minutes.has(cursor.getMinutes())) {
      cursor.setMinutes(cursor.getMinutes() + 1, 0, 0);
      continue;
    }
    return cursor;
  }
  return null;
}

// ------------------------------------------------------------------ intervals

const DURATION_UNITS = { s: 1, m: 60, h: 3600, d: 86400, w: 604800 };

/** `90`, `30m`, `2h`, `1d` → seconds. Bare numbers are seconds. */
export function parseDuration(text, { what = "interval" } = {}) {
  const raw = String(text).trim().toLowerCase();
  const match = /^(\d+(?:\.\d+)?)\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|week|weeks)?$/.exec(raw);
  if (!match) throw new CronError(`${what} "${text}" is not a duration (try 90, 30m, 2h, 1d)`);
  const value = Number(match[1]);
  const unit = (match[2] ?? "s")[0];
  const seconds = Math.round(value * DURATION_UNITS[unit]);
  if (seconds <= 0) throw new CronError(`${what} must be positive, got "${text}"`);
  if (seconds < 30) throw new CronError(`${what} must be at least 30s (got "${text}")`);
  return seconds;
}

export function formatDuration(seconds) {
  if (seconds % 86400 === 0) return `${seconds / 86400}d`;
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}

// ------------------------------------------------------------------- the jobs

export function readJobs(env = process.env) {
  const path = jobsPath(env);
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return Array.isArray(parsed?.jobs) ? parsed.jobs : [];
  } catch {
    return [];
  }
}

export function writeJobs(jobs, env = process.env) {
  const path = jobsPath(env);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ version: 1, jobs }, null, 2)}\n`, "utf8");
  renameSync(tmp, path);
}

export function newJobId(existing = []) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const id = randomBytes(3).toString("hex");
    if (!existing.some((job) => job.id === id)) return id;
  }
  throw new CronError("could not generate a job id");
}

/**
 * Build a job description from the three schedule shapes.
 * Exactly one of `at` / `every` / `cron` must be given.
 */
export function buildSchedule({ at, every, cron }, now = new Date()) {
  const present = (value) => value !== undefined && value !== null && value !== "";
  const given = [at, every, cron].filter(present).length;
  if (given === 0) throw new CronError("give a time: --at <ISO>, --every <duration> or --cron \"<expr>\"");
  if (given > 1) throw new CronError("pick one of --at, --every, --cron");

  if (present(at)) {
    const when = new Date(at);
    if (Number.isNaN(when.getTime())) throw new CronError(`"${at}" is not a date (use ISO 8601, e.g. 2026-11-21T09:00)`);
    if (when.getTime() <= now.getTime()) throw new CronError(`"${at}" is in the past`);
    return { kind: "once", at: when.toISOString() };
  }
  if (present(every)) {
    return { kind: "every", every: parseDuration(every, { what: "interval" }) };
  }
  const parsed = parseCron(cron);
  if (!nextCronRun(parsed, now)) throw new CronError(`"${cron}" never fires`);
  return { kind: "cron", cron: parsed.source };
}

/** When should this job run next? `null` for a one-shot that already ran. */
export function nextRun(job, from = new Date()) {
  if (job.schedule.kind === "once") {
    if (job.lastRun) return null;
    return new Date(job.schedule.at);
  }
  if (job.schedule.kind === "every") {
    const base = job.lastRun ? new Date(job.lastRun) : new Date(job.createdAt);
    return new Date(base.getTime() + job.schedule.every * 1000);
  }
  const parsed = parseCron(job.schedule.cron);
  const since = job.lastRun ? new Date(job.lastRun) : new Date(new Date(job.createdAt).getTime() - 60000);
  return nextCronRun(parsed, since);
}

export function describeSchedule(schedule) {
  if (schedule.kind === "once") return `once at ${schedule.at}`;
  if (schedule.kind === "every") return `every ${formatDuration(schedule.every)}`;
  return `cron ${schedule.cron}`;
}

// ------------------------------------------------------------------- the tick

function withLock(fn, env = process.env) {
  const path = lockPath(env);
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) {
    try {
      const age = Date.now() - statSync(path).mtimeMs;
      if (age < LOCK_STALE_MS) return { skipped: true };
      unlinkSync(path);
    } catch {
      /* raced with another tick; fall through and try to take the lock */
    }
  }
  let fd;
  try {
    fd = openSync(path, "wx");
  } catch {
    return { skipped: true };
  }
  try {
    writeFileSync(fd, `${process.pid} ${new Date().toISOString()}\n`);
    return fn();
  } finally {
    try {
      closeSync(fd);
    } catch {
      /* already closed */
    }
    try {
      unlinkSync(path);
    } catch {
      /* somebody cleaned it up */
    }
  }
}

function logLine(line, env = process.env) {
  const path = cronLogPath(env);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${new Date().toISOString()} ${line}\n`, "utf8");
}

/**
 * Run every job that is due. `deliver(job)` is supplied by the caller so this
 * module stays free of tmux and config details.
 */
export function tick({ now = new Date(), env = process.env, deliver, dryRun = false } = {}) {
  return withLock(() => {
    const jobs = readJobs(env);
    const ran = [];
    const skipped = [];
    let changed = false;

    for (const job of jobs) {
      // A paused job keeps its schedule and its history; it simply does not fire.
      // Deleting and re-adding it would lose both, which is why the flag exists.
      if (job.paused) {
        skipped.push({ id: job.id, reason: "paused" });
        continue;
      }
      const due = nextRun(job, now);
      if (!due || due.getTime() > now.getTime()) {
        if (job.schedule.kind === "once" && job.lastRun) {
          skipped.push({ id: job.id, reason: "finished" });
        }
        continue;
      }

      const lateBy = now.getTime() - due.getTime();
      const catchUp = (job.catchUp ?? DEFAULT_CATCH_UP_SECONDS) * 1000;
      if (lateBy > catchUp) {
        job.lastStatus = `skipped: missed by ${formatDuration(Math.round(lateBy / 1000))} (catch-up ${formatDuration(catchUp / 1000)})`;
        job.lastAttempt = now.toISOString();
        job.skipped = (job.skipped ?? 0) + 1;
        if (job.schedule.kind === "once") job.done = true;
        // Resync the schedule: without this the job stays in the past forever,
        // is "missed" on every tick and never runs again after one long outage.
        job.lastRun = now.toISOString();
        skipped.push({ id: job.id, reason: job.lastStatus });
        changed = true;
        continue;
      }

      const result = dryRun
        ? { status: "dry-run", text: `would deliver to ${job.session}` }
        : deliver(job);

      job.lastAttempt = now.toISOString();
      job.lastStatus = result.status;
      if (result.status === "delivered") {
        job.lastRun = now.toISOString();
        job.runs = (job.runs ?? 0) + 1;
        ran.push({ id: job.id, session: job.session, lateBy });
        logLine(
          `delivered ${job.id} → ${job.session}${result.text ? ` ${result.text}` : ""}${lateBy > 60000 ? ` (late by ${formatDuration(Math.round(lateBy / 1000))})` : ""}`,
          env,
        );
      } else if (result.status.startsWith("deferred:")) {
        // Not a failure and not a run: leave lastRun alone so the same schedule
        // comes due again on the next tick, once the pane is free.
        logLine(`deferred ${job.id} → ${job.session}: ${result.status}`, env);
        skipped.push({ id: job.id, reason: result.status });
        changed = true;
        continue;
      } else {
        logLine(`failed ${job.id} → ${job.session}: ${result.text ?? result.status}`, env);
        skipped.push({ id: job.id, reason: result.status });
        if (job.schedule.kind === "once") job.lastRun = now.toISOString();
      }
      if (job.schedule.kind === "once") job.done = true;
      changed = true;
    }

    const pruned = jobs.filter((job) => !(job.done && job.schedule.kind === "once"));
    if (changed || pruned.length !== jobs.length) writeJobs(pruned, env);

    return { ran, skipped, total: pruned.length };
  });
}

/** Mark a job as run right now (used by `pp cron run <id>`). */
export function recordRun(job, status, env = process.env) {
  job.lastAttempt = new Date().toISOString();
  job.lastStatus = status;
  if (status === "delivered") {
    job.lastRun = job.lastAttempt;
    job.runs = (job.runs ?? 0) + 1;
  }
  if (job.schedule.kind === "once") job.done = true;
  writeJobs(readJobs(env).map((entry) => (entry.id === job.id ? job : entry)), env);
}

/** Pause or resume a job without touching its schedule or its history. */
export function setJobPaused(id, paused, env = process.env) {
  const jobs = readJobs(env);
  const job = jobs.find((entry) => entry.id === id);
  if (!job) return false;
  if (paused) job.paused = true;
  else delete job.paused;
  writeJobs(jobs, env);
  return true;
}

export function removeJob(id, env = process.env) {
  const jobs = readJobs(env);
  const remaining = jobs.filter((job) => job.id !== id);
  if (remaining.length === jobs.length) return false;
  writeJobs(remaining, env);
  return true;
}

export function resetJob(id, env = process.env) {
  const jobs = readJobs(env);
  const job = jobs.find((entry) => entry.id === id);
  if (!job) return false;
  job.lastRun = undefined;
  job.lastAttempt = undefined;
  job.lastStatus = undefined;
  job.done = false;
  writeJobs(jobs, env);
  return true;
}
