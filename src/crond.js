import { spawnSync } from "node:child_process";

/**
 * Linux crond integration.
 *
 * We do not put one line per job in the crontab: a single line that calls
 * `pp cron tick` every minute is enough, and it is far easier to inspect,
 * upgrade and remove than a block that grows and shrinks whenever a job is
 * added. pp keeps the schedules (cron expressions included) in its own job
 * store and compares them to the clock on each tick, which also gives us
 * catch-up after downtime — something plain crontab entries cannot do.
 *
 * A `@reboot` line covers the machine having been off: crond runs it once at
 * boot, which is exactly the moment tick needs to notice missed jobs.
 */

export const BLOCK_BEGIN = "# >>> pi-plus cron (managed by pp — do not edit by hand) >>>";
export const BLOCK_END = "# <<< pi-plus cron <<<";

export class CrondError extends Error {
  constructor(message, code = "crond") {
    super(message);
    this.name = "CrondError";
    this.code = code;
  }
}

/** Read the current user's crontab. Missing crontab is `""`, not an error. */
export function readCrontab(run = spawnSync) {
  const result = run("crontab", ["-l"], { encoding: "utf8" });
  if (result.error?.code === "ENOENT") {
    throw new CrondError("crontab is not installed on this machine (install cron, or use --via systemd)");
  }
  if (result.status === 0) return result.stdout ?? "";
  const stderr = `${result.stderr ?? ""}`.toLowerCase();
  if (stderr.includes("no crontab")) return "";
  throw new CrondError(`crontab -l failed: ${(result.stderr || result.stdout || "").trim()}`);
}

export function writeCrontab(text, run = spawnSync) {
  const result = run("crontab", ["-"], { input: text, encoding: "utf8" });
  if (result.error?.code === "ENOENT") {
    throw new CrondError("crontab is not installed on this machine");
  }
  if (result.status !== 0) {
    throw new CrondError(`crontab - failed: ${(result.stderr || result.stdout || "").trim()}`);
  }
}

/** Everything except pp's managed block, with trailing blanks kept tidy. */
export function stripBlock(text) {
  const lines = String(text).split("\n");
  const kept = [];
  let inside = false;
  for (const line of lines) {
    if (line.trim() === BLOCK_BEGIN) {
      inside = true;
      continue;
    }
    if (line.trim() === BLOCK_END) {
      inside = false;
      continue;
    }
    if (!inside) kept.push(line);
  }
  while (kept.length && kept[kept.length - 1].trim() === "") kept.pop();
  return kept.join("\n");
}

export function hasBlock(text) {
  return String(text).includes(BLOCK_BEGIN);
}

export function blockLines(text) {
  const lines = String(text).split("\n");
  const start = lines.findIndex((line) => line.trim() === BLOCK_BEGIN);
  if (start === -1) return [];
  const end = lines.findIndex((line, index) => index > start && line.trim() === BLOCK_END);
  return lines.slice(start + 1, end === -1 ? lines.length : end).filter((line) => line.trim() && !line.trim().startsWith("#"));
}

/** The two crontab entries pp needs: the minute tick and the boot catch-up. */
export function renderBlockLines({ scriptPath, nodePath = process.execPath, logPath = null }) {
  const quoted = (value) => `"${String(value).replace(/"/g, '\\"')}"`;
  const command = `${quoted(nodePath)} ${quoted(scriptPath)} cron tick --quiet`;
  const suffix = logPath ? ` >> ${quoted(logPath)} 2>&1` : " > /dev/null 2>&1";
  return [`* * * * * ${command}${suffix}`, `@reboot ${command}${suffix}`];
}

export function renderBlock({ scriptPath, nodePath = process.execPath, logPath = null, env = {} }) {
  const envLines = Object.entries(env)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => {
      // cron gets a minimal PATH, so pp's own node has to be findable
      const cleaned = key === "PATH" ? [...new Set(String(value).split(":"))].join(":") : value;
      return `${key}="${String(cleaned).replace(/"/g, '\\"')}"`;
    });
  return [
    BLOCK_BEGIN,
    ...envLines,
    ...renderBlockLines({ scriptPath, nodePath, logPath }),
    BLOCK_END,
  ].join("\n");
}

/** Install (or update) the managed block, leaving every other line alone. */
export function installBlock({ scriptPath, nodePath, logPath = null, env = {}, dryRun = false, run = spawnSync }) {
  const current = readCrontab(run);
  const block = renderBlock({ scriptPath, nodePath, logPath, env });
  const next = `${stripBlock(current)}\n\n${block}\n`.replace(/^\n+/, "");
  if (!dryRun) writeCrontab(next, run);
  return { changed: current !== next, crontab: dryRun ? current : next, block };
}

export function uninstallBlock({ dryRun = false, run = spawnSync } = {}) {
  const current = readCrontab(run);
  if (!hasBlock(current)) return { removed: false, crontab: current };
  const next = stripBlock(current);
  if (!dryRun) writeCrontab(next ? `${next}\n` : "", run);
  return { removed: true, crontab: next };
}

/** Is the minute tick present in this crontab text? */
export function blockStatus(text) {
  const lines = blockLines(text);
  return {
    installed: lines.length > 0,
    tick: lines.some((line) => line.includes("cron tick")),
    reboot: lines.some((line) => line.trim().startsWith("@reboot")),
    lines,
  };
}
