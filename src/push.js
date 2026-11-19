// Push a local file to another machine over ssh and prefill it into a tmux
// session there. Almost nothing here knows about ssh authentication: the
// strings are handed to the system `ssh` / `scp`, which read ~/.ssh/config,
// the agent and the ControlMaster socket on its own.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { homedir, hostname as osHostname } from "node:os";
import { basename, dirname, join } from "node:path";
import { expandPath, resolve, shellQuote } from "./config.js";

/** How long the reused ssh master connection is kept alive. */
export const DEFAULT_PERSIST_SECONDS = 600;
/** ControlMaster socket template: one per user@host:port. */
export const CONTROL_PATH_TEMPLATE = "~/.ssh/cm-pp-%r@%h-%p";
/** Where drops land on the remote side, before the per-session directory. */
export const DEFAULT_DROPS_ROOT = "~/.pi/plus/drops";

export class PushError extends Error {
  constructor(message, code = "push") {
    super(message);
    this.name = "PushError";
    this.code = code;
  }
}

/**
 * Parse a push target. Accepted shapes:
 *
 *   host                      host
 *   user@host                 user@host
 *   host:2222                 port
 *   host:delta                tmux session on the remote side
 *   user@host:2222#delta      port and session
 */
export function parsePushTarget(spec) {
  const raw = String(spec ?? "").trim();
  if (!raw) throw new PushError("empty ssh target", "target");

  let rest = raw;
  let session = null;
  const hash = rest.lastIndexOf("#");
  if (hash !== -1) {
    session = rest.slice(hash + 1) || null;
    rest = rest.slice(0, hash);
  }

  let port = null;
  const colon = rest.lastIndexOf(":");
  if (colon !== -1) {
    const head = rest.slice(0, colon);
    const tail = rest.slice(colon + 1);
    if (head.includes(":")) {
      throw new PushError(`"${spec}" has too many ":" — use [user@]host[:port][#session]`, "target");
    }
    if (!head) throw new PushError(`"${spec}" has no host part`, "target");
    if (!tail) throw new PushError(`"${spec}" ends with ":" — use host:port or host#session`, "target");
    rest = head;
    if (/^\d+$/.test(tail)) port = Number(tail);
    else session = tail;
  }

  const at = rest.lastIndexOf("@");
  const user = at === -1 ? null : rest.slice(0, at);
  const host = at === -1 ? rest : rest.slice(at + 1);
  if (!host) throw new PushError(`"${spec}" has no host part`, "target");
  if (user === "") throw new PushError(`"${spec}" has an empty user part`, "target");
  if (port !== null && (!Number.isInteger(port) || port < 1 || port > 65535)) {
    throw new PushError(`"${spec}" has an invalid port`, "target");
  }
  if (session !== null && !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(session)) {
    throw new PushError(`"${spec}" has an invalid tmux session name "${session}"`, "target");
  }

  return {
    raw,
    user,
    host,
    port,
    session,
    target: `${user ? `${user}@` : ""}${host}`,
  };
}

/** Resolve the ControlMaster socket path (~ expanded by the caller's shell normally). */
export function controlPathPath(template = CONTROL_PATH_TEMPLATE, home = homedir()) {
  return expandPath(template, process.env, home);
}

/** Options every ssh/scp call shares, so they all land on the same master. */
export function sshBaseArgs(target, { controlPath = null, port = null } = {}) {
  const args = [];
  if (port) args.push("-p", String(port));
  if (controlPath) args.push("-o", `ControlPath=${controlPath}`);
  return args;
}

/** Parse `ps -axo pid=,command=` output for the most recent ssh client. */
export function parseActiveSsh(psOutput) {
  const found = [];
  for (const line of String(psOutput).split("\n")) {
    const match = /^\s*(\d+)\s+(.+)$/.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    const argv = match[2].trim().split(/\s+/);
    if (!argv.length) continue;
    const binary = argv[0];
    if (binary !== "ssh" && !binary.endsWith("/ssh")) continue;
    const rest = argv.slice(1);
    // `ssh -O check`, `ssh -M -N -f` and friends are connection plumbing, not logins.
    if (rest.includes("-O") || rest.includes("-N") || rest.includes("-M")) continue;
    const operand = sshOperand(rest);
    if (!operand?.operand) continue;
    try {
      const parsed = parsePushTarget(operand.operand);
      found.push({ pid, ...parsed, port: parsed.port ?? operand.port });
    } catch {
      // not something we can push to (ProxyJump hosts, `ssh -O`, …)
    }
  }
  if (!found.length) return null;
  found.sort((a, b) => b.pid - a.pid);
  return found[0];
}

/** First non-option operand of an ssh argv (options that take a value are skipped). */
function sshOperand(args) {
  const withValue = new Set([
    "-b", "-c", "-D", "-e", "-F", "-I", "-i", "-J", "-L", "-l", "-m", "-O",
    "-o", "-p", "-Q", "-R", "-S", "-W", "-w",
  ]);
  let port = null;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg.startsWith("-")) {
      if (withValue.has(arg)) {
        if (arg === "-p") port = Number(args[i + 1]) || null;
        i += 1;
      }
      continue;
    }
    return { operand: arg, port };
  }
  return null;
}

/** Detect the ssh host this shell most likely belongs to, from the process table. */
export function detectActiveSshTarget({ psOutput = null } = {}) {
  if (psOutput !== null) return parseActiveSsh(psOutput);
  const result = spawnSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" });
  if (result.status !== 0) return null;
  return parseActiveSsh(result.stdout || "");
}

/**
 * Work out where a push goes. Precedence:
 *   --push/--to spec → $PP_PUSH_TARGET → config `push:` block → detected ssh → hostname
 */
export function resolvePushTarget({
  spec = null,
  env = process.env,
  configPush = null,
  detected = null,
  host = osHostname(),
} = {}) {
  let chosen = spec ?? env.PP_PUSH_TARGET ?? configPush?.target ?? null;
  let source = spec ? "argument" : env.PP_PUSH_TARGET ? "PP_PUSH_TARGET" : configPush?.target ? "config" : null;
  if (!chosen && detected) {
    chosen = detected.raw ?? detected.target;
    source = "detected";
  }
  if (!chosen) {
    chosen = host;
    source = "hostname";
  }
  const parsed = parsePushTarget(chosen);
  const session = configPush?.session && !parsed.session ? parsePushTarget(`x@x#${configPush.session}`).session : parsed.session;
  return { ...parsed, session, source, port: parsed.port ?? (configPush?.port ? Number(configPush.port) : null) };
}

/** Remote directory a drop lands in. */
export function remoteDropsDir({ session = null, dir = null, dropsRoot = DEFAULT_DROPS_ROOT } = {}) {
  const root = dir || join(dropsRoot, session || "inbox");
  return root;
}

/** Remote argv that types the path into a tmux pane (literal, no Enter). */
export function tmuxPrefillArgs({ session, path, socket = null }) {
  if (!session) throw new PushError("a tmux session name is required to prefill", "target");
  const args = [];
  if (socket) args.push("-L", socket);
  args.push("send-keys", "-t", `=${session}:`, "-l", "--", path);
  return args;
}

/** Remote command that prints the most recently active attached session. */
export function attachedSessionArgs({ socket = null } = {}) {
  const args = [];
  if (socket) args.push("-L", socket);
  args.push("list-clients", "-F", "#{client_activity} #{client_session}");
  return args;
}

/** Pick the newest attached session from `list-clients` output. */
export function parseAttachedSession(output) {
  const rows = String(output)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [activity, session] = line.split(/\s+/, 2);
      return { activity: Number(activity) || 0, session };
    })
    .filter((row) => row.session);
  if (!rows.length) return null;
  rows.sort((a, b) => b.activity - a.activity);
  return rows[0].session;
}

/** A file that is safe to hand to scp and to type into a shell. */
export function assertReadableFile(path) {
  const abs = resolve(expandPath(String(path)));
  if (!existsSync(abs)) throw new PushError(`no such file: ${abs}`, "file");
  const info = statSync(abs);
  if (!info.isFile()) throw new PushError(`not a regular file: ${abs}`, "file");
  return abs;
}

/** Timestamped name used for drops, derived from whatever the editor gave us. */
export function dropName(file, now = new Date()) {
  const stamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
  ].join("-");
  const clock = [now.getHours(), now.getMinutes(), now.getSeconds()].map((n) => String(n).padStart(2, "0")).join("");
  const base = basename(file).replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "drop";
  return `${stamp}_${clock}-${base}`;
}

/** Whether an ssh master is alive for this target. */
export function masterAlive(target, { controlPath, port = null } = {}) {
  const result = spawnSync(
    "ssh",
    [...sshBaseArgs(target.target, { controlPath, port }), "-O", "check", target.target],
    { encoding: "utf8" },
  );
  return result.status === 0;
}

/** Start (or reuse) a background master connection; may prompt for a password once. */
export function ensureMaster(target, { controlPath, port = null, persistSeconds = DEFAULT_PERSIST_SECONDS, ui = null } = {}) {
  if (masterAlive(target, { controlPath, port })) {
    ui?.info?.(`reusing ssh connection to ${target.target}`);
    return { reused: true };
  }
  if (ui?.verbose) ui.info?.(`opening a connection to ${target.target} (a password prompt can appear here once)`);
  const args = [
    ...sshBaseArgs(target.target, { controlPath, port }),
    "-M",
    "-N",
    "-f",
    "-o",
    `ControlPersist=${persistSeconds}`,
    target.target,
  ];
  const result = spawnSync("ssh", args, { stdio: "inherit" });
  if (result.status !== 0) {
    throw new PushError(
      `cannot open an ssh connection to ${target.target} (exit ${result.status ?? "?"}); check the host and your key/password`,
      "auth",
    );
  }
  return { reused: false };
}

/** Run a command on the remote side and return stdout. */
export function sshRun(target, command, { controlPath, port = null, inherit = false } = {}) {
  // A remote command that starts with "-" (tmux -L …) would be eaten by the
  // remote login shell's own option parsing; hand it to `sh -c` instead.
  const remote = String(command).startsWith("-") ? `sh -c -- ${shellQuote(command)}` : String(command);
  const argv = [...sshBaseArgs(target.target, { controlPath, port }), "--", target.target, remote];
  const result = spawnSync("ssh", argv, {
    encoding: "utf8",
    stdio: inherit ? "inherit" : ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    const detail = (result.stderr || "").trim();
    throw new PushError(
      `ssh ${target.target} failed (exit ${result.status ?? "?"})${detail ? `: ${detail.split("\n")[0]}` : ""}`,
      "remote",
    );
  }
  return result.stdout || "";
}

/** Copy one file to the remote side. */
export function scpTo(target, file, remotePath, { controlPath, port = null } = {}) {
  const result = spawnSync(
    "scp",
    [...sshBaseArgs(target.target, { controlPath, port }).map((arg) => (arg === "-p" ? "-P" : arg)), file, `${target.target}:${remotePath}`],
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    const detail = (result.stderr || "").trim();
    throw new PushError(
      `scp to ${target.target} failed (exit ${result.status ?? "?"})${detail ? `: ${detail.split("\n")[0]}` : ""}`,
      "remote",
    );
  }
}

/**
 * Turn `~/x` into an absolute remote path: scp and `mkdir` both run under a
 * remote shell that may quote differently, so we ask the remote side for $HOME
 * once and use absolute paths everywhere afterwards.
 */
export async function resolveRemoteDir(dir, target, controlPath = null, runner = sshRun) {
  const path = String(dir ?? "");
  if (!path.startsWith("~")) return path;
  if (path !== "~" && !path.startsWith("~/")) return path;
  const home = runner(target, 'printf %s "$HOME"', { controlPath, port: target.port }).trim();
  if (!home) throw new PushError(`cannot resolve $HOME on ${target.target}`, "remote");
  return path === "~" ? home : `${home}/${path.slice(2)}`;
}

/**
 * Full push: mkdir remote dir, scp the file, then type its path into a tmux pane.
 * Returns a description of what was done (also used for --json).
 */
export async function pushFile({
  file,
  target,
  session = null,
  remoteDir = null,
  socket = null,
  prefill = true,
  controlPath = controlPathPath(),
  typeIntoPane = true,
} = {}) {
  const abs = assertReadableFile(file);
  const dir = await resolveRemoteDir(remoteDir ?? remoteDropsDir({ session }), target, controlPath);
  const remotePath = `${dir}/${basename(abs)}`;
  const steps = [];

  sshRun(target, `mkdir -p ${shellQuote(dir)}`, { controlPath, port: target.port });
  steps.push(`mkdir ${dir}`);

  scpTo(target, abs, remotePath, { controlPath, port: target.port });
  steps.push(`scp ${abs} → ${target.target}:${remotePath}`);

  let usedSession = session;
  if (!usedSession) {
    const attached = parseAttachedSession(
      sshRun(target, shellQuoteArgs(["tmux", ...attachedSessionArgs({ socket })]), { controlPath, port: target.port }),
    );
    usedSession = attached;
  }

  if (prefill && typeIntoPane) {
    if (!usedSession) {
      throw new PushError(
        `copied to ${target.target}:${remotePath}, but nothing is attached there; pass --to <session>`,
        "target",
      );
    }
    sshRun(target, shellQuoteArgs(["tmux", ...tmuxPrefillArgs({ session: usedSession, path: remotePath, socket })]), {
      controlPath,
      port: target.port,
    });
    steps.push(`prefilled ${usedSession}`);
  }

  return { host: target.target, session: usedSession, remotePath, steps };
}

/** Join argv into a single shell command string for the remote side. */
export function shellQuoteArgs(args) {
  return args.map((arg) => shellQuote(arg)).join(" ");
}

/** Directory helper shared with the CLI so --dir/--name behave predictably. */
export function dropDir({ root = DEFAULT_DROPS_ROOT, session = null, dir = null } = {}) {
  const target = dir || (session ? join(root, session) : root);
  return target;
}

/** Make sure the local directory for a screenshot exists. */
export function ensureLocalDir(dir) {
  mkdirSync(dir, { recursive: true });
  return dir;
}

export { dirname, join };
