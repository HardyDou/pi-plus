import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { shellQuote } from "./config.js";

const execFileAsync = promisify(execFile);

/**
 * tmux has two target syntaxes: `=name` for sessions (exact match) and
 * `=name:` for panes (exact session, current window/pane). send-keys and
 * capture-pane need the pane form, otherwise tmux reports "can't find pane".
 */
export function paneTarget(name) {
  return `=${name}:`;
}

export class TmuxError extends Error {
  constructor(message) {
    super(message);
    this.name = "TmuxError";
  }
}

import { sshInvocation } from "./nodes.js";

const FIELD_SEP = "\u001f";

/**
 * tmux 3.6 hands the separator byte through untouched; tmux 3.4 (common on
 * servers) escapes control bytes in `-F` output, so the line arrives with the
 * four literal characters `\037` instead of 0x1f. Undo that before parsing.
 */
export function decodeFields(stdout) {
  return String(stdout).split("\\037").join(FIELD_SEP);
}

/** Sleep without a dependency (Atomics on a throwaway buffer blocks exactly). */
export function sleep(ms) {
  if (!(ms > 0)) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.round(ms));
}

/**
 * Coarse fingerprint of a pane's last lines: ANSI stripped, trailing padding
 * dropped, blank lines removed. Used to tell "Enter was accepted" (the screen
 * moves) from "Enter was swallowed by a paste" (it does not move at all).
 */
export function screenSignature(text) {
  return String(text)
    .replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "")
    .split("\n")
    .map((line) => line.replace(/\s+$/, ""))
    .filter((line) => line.trim())
    .slice(-6)
    .join("\n");
}

/**
 * The screen without the things that move on their own: pi's braille spinner
 * animates every few hundred milliseconds and its "Working 1m 23s" counter ticks
 * every second, so a raw screen comparison says "active" forever. This signature
 * only changes when the *content* does — which is what "stuck" means.
 */
export function contentSignature(text) {
  const lines = String(text)
    .replace(/[\u2800-\u28ff]/gu, "")
    .replace(/\b\d+(\.\d+)?\s*(ms|s|m|h|d)\b/g, "#")
    .split("\n")
    // pi's status line is a set of live counters (tokens, context %, cost, sub-agents).
    // The numbers move every frame; the shape is what tells you something happened.
    .map((line) => (/[↑↓]|\$\s*\d|CH\d|%/.test(line) ? line.replace(/\d+(?:[.,]\d+)?\s*[kKmMgG]?/g, "#") : line));
  return screenSignature(lines.join("\n"));
}

const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g;

/** The rule lines a pi TUI draws above and below its input box. */
export function isRule(line) {
  return /^─{10,}$/.test(line.trim());
}

/**
 * The last line of the transcript that says something. Rules, the status line
 * (tokens, cost, context %) and the input box below the last rule are all noise
 * when the question is "what is it doing right now".
 */
export function lastActionLine(text, limit = 72) {
  const lines = String(text).split("\n");
  let lastRule = -1;
  lines.forEach((line, i) => {
    if (isRule(line)) lastRule = i;
  });
  for (let i = (lastRule >= 0 ? lastRule : lines.length) - 1; i >= 0; i -= 1) {
    const line = lines[i].replace(ANSI, "").trim();
    if (!line || isRule(line)) continue;
    if (/[\u2800-\u28ff]/.test(line)) continue;
    if (/[\u2191\u2193]|\$\s*\d|\bCH\d|\d+%/.test(line)) continue;
    if (/^(Working|Thinking|Elapsed)\b/.test(line)) continue;
    if (/^[›❯]/.test(line)) continue;
    if (/^(?:\d+(?:\.\d+)?\s*[hms]\s*)+$/.test(line)) continue;
    const short = line.replace(/\s+/g, " ");
    return short.length > limit ? `${short.slice(0, limit - 1)}…` : short;
  }
  return "";
}

/**
 * Whatever is sitting in the input box: the lines between the last two rules of
 * a pi screen. Empty means the box is empty, i.e. nothing is waiting to be sent.
 */
/**
 * Does this screen have pi's input box at all?
 *
 * An empty box is a ready box: the draft being "" just means nobody typed yet.
 * What matters is that the two rule lines are drawn, which only happens once pi
 * has painted its editor.
 */
export function hasEditor(text) {
  return String(text ?? "").split("\n").filter(isRule).length >= 2;
}

export function editorDraft(text) {
  const lines = String(text)
    .replace(ANSI, "")
    .split("\n")
    .map((line) => line.replace(/\s+$/, ""));
  const rules = [];
  lines.forEach((line, index) => {
    if (isRule(line)) rules.push(index);
  });
  if (rules.length < 2) return "";
  const box = lines.slice(rules[rules.length - 2] + 1, rules[rules.length - 1]);
  return box.join("\n").trim();
}

/**
 * Is the agent in this pane still working on a turn? pi draws a braille spinner
 * into a rule line while it is; input typed meanwhile piles up in the editor
 * instead of being submitted, so callers should wait rather than type.
 *
 * Only rule lines count: braille inside the draft itself is just text, and a
 * false positive here would postpone deliveries forever.
 */
export function looksBusy(text) {
  return String(text)
    .replace(ANSI, "")
    .split("\n")
    .some((line) => /^─{2,}\s*[\u2800-\u28ff]/u.test(line));
}

/** Do these two texts describe the same draft? Wrapping makes exact matches rare. */
export function sameDraft(draft, text, chars = 24) {
  const squeeze = (value) => String(value).replace(/\s+/g, "");
  const wanted = squeeze(text).slice(0, chars);
  if (!wanted) return false;
  return squeeze(draft).includes(wanted);
}

/** Resolve a bare command name against PATH (absolute paths are kept as-is). */
export function resolveExecutable(command, env = process.env) {
  if (!command || command.includes("/") || command.includes("\\")) return command;
  const dirs = String(env.PATH ?? "").split(delimiter).filter(Boolean);
  for (const dir of dirs) {
    const candidate = join(dir, command);
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      /* keep looking */
    }
  }
  return command;
}

/** The one list-panes query both the sync and the async reader use. */
export const SESSION_QUERY = [
  "list-panes",
  "-a",
  "-F",
  [
    "#{session_name}",
    "#{pane_id}",
    "#{pane_pid}",
    "#{pane_current_command}",
    "#{pane_dead}",
    "#{pane_current_path}",
    "#{session_created}",
    "#{session_attached}",
    // window_activity moves when a pane prints; session_activity only moves
    // on attach/detach, which made "idle 4h" mean "nobody looked at it"
    "#{window_activity}",
  ].join(FIELD_SEP),
];

const CLIENT_QUERY = [
  "list-clients",
  "-F",
  ["#{client_name}", "#{client_session}", "#{client_activity}", "#{client_user}", "#{client_tty}"].join(FIELD_SEP),
];

function parseClientLines(stdout) {
  return String(stdout ?? "")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => {
      const [name, session, activity, user, tty] = decodeFields(line).split(FIELD_SEP);
      return { name, session, activity: Number(activity) || 0, user: user || "", tty: tty || "" };
    });
}

/** Turn `list-panes` output into the Map every caller expects. */
export function parseSessionLines(stdout) {
  const sessions = new Map();
  for (const line of decodeFields(stdout).split("\n")) {
    if (!line.trim()) continue;
    const [name, paneId, pid, command, dead, path, created, attached, activity] = line.split(FIELD_SEP);
    const entry = sessions.get(name) ?? {
      name,
      path,
      created: Number(created) || 0,
      attached: Number(attached) || 0,
      activity: Number(activity) || 0,
      panes: [],
    };
    entry.activity = Math.max(entry.activity, Number(activity) || 0);
    // the path is what "where does this session live" answers, and the only
    // source for a session that is running but not in the config
    entry.panes.push({ id: paneId, pid: Number(pid) || 0, command, dead: dead === "1", path });
    sessions.set(name, entry);
  }
  return sessions;
}

export class Tmux {
  /**
   * `remote` turns this into "tmux on another machine": pass `{ node }` and
   * every call becomes `ssh <node> tmux <args>`, with the ssh options (port,
   * identity, password via sshpass) coming from the node itself.
   */
  constructor({ socket = null, dryRun = false, verbose = false, env = process.env, remote = null } = {}) {
    this.socket = socket;
    this.dryRun = dryRun;
    this.verbose = verbose;
    this.env = env;
    this.remote = remote;
  }

  get label() {
    return this.remote ? `tmux@${this.remote.node.name}` : "tmux";
  }

  tmuxArgs(args) {
    return this.socket ? ["-L", this.socket, ...args] : [...args];
  }

  /** The command line, for dry-run/verbose display. */
  args(args) {
    const inner = ["tmux", ...this.tmuxArgs(args)];
    if (!this.remote) return inner;
    const inv = sshInvocation(this.remote.node, [this.wire(args)], { env: this.env, batch: true });
    return [inv.command, ...inv.argv];
  }

  /**
   * The command as it has to travel over ssh: one string, every token quoted.
   * ssh joins its arguments with spaces and lets the remote shell re-split
   * them, so `send-keys -l -- "echo hi"` would otherwise arrive as two keys.
   */
  wire(args) {
    return ["tmux", ...this.tmuxArgs(args)].map((part) => shellQuote(String(part))).join(" ");
  }

  /** The command to spawn plus the environment it needs (sshpass sets SSHPASS). */
  spawnFor(args, { tty = false, batch = true } = {}) {
    if (!this.remote) return { command: "tmux", argv: this.tmuxArgs(args), env: this.env };
    const inv = sshInvocation(this.remote.node, [this.wire(args)], {
      env: this.env,
      batch,
      tty,
    });
    return { command: inv.command, argv: inv.argv, env: { ...this.env, ...inv.env } };
  }

  /**
   * Run tmux; throws on non-zero unless `allowFailure`. Read-only queries pass
   * `readOnly: true` so `--dry-run` can still report real session state.
   */
  /** Run one tmux command without blocking; same contract as run(). */
  async runAsync(args) {
    const { command, argv, env } = this.spawnFor(args, {});
    try {
      const { stdout, stderr } = await execFileAsync(command, argv, { env, maxBuffer: 16 * 1024 * 1024 });
      return { status: 0, stdout, stderr };
    } catch (error) {
      const status = typeof error?.code === "number" ? error.code : 1;
      return { status, stdout: String(error?.stdout ?? ""), stderr: String(error?.stderr ?? error?.message ?? error) };
    }
  }

  run(args, { allowFailure = false, capture = true, readOnly = false, stdinInherit = false } = {}) {
    const full = this.args(args);
    const shown = full.join(" ");
    if (this.dryRun && !readOnly) {
      if (this.verbose) process.stderr.write(`[dry-run] ${shown}\n`);
      return { status: 0, stdout: "", stderr: "" };
    }
    if (this.verbose) process.stderr.write(`+ ${shown}\n`);
    const spawnSpec = this.spawnFor(args);
    const res = spawnSync(spawnSpec.command, spawnSpec.argv, {
      encoding: "utf8",
      env: spawnSpec.env,
      // tmux hands a `pipe-pane` command the client's stdin; torn away it can be
      // opened and closed in the same breath ("the log simply never grows").
      stdio: [stdinInherit ? "inherit" : "ignore", "pipe", "pipe"],
    });
    if (res.error && res.error.code === "ENOENT") {
      throw new TmuxError(
        spawnSpec.command === "sshpass"
          ? `node "${this.remote?.node.name}": a password node needs sshpass (apt install sshpass) or use identity:`
          : this.remote
            ? "ssh is not installed (or not on PATH)"
            : "tmux is not installed (or not on PATH)",
      );
    }
    const out = {
      status: res.status ?? 1,
      stdout: capture ? (res.stdout ?? "") : "",
      stderr: capture ? (res.stderr ?? "") : "",
    };
    if (!allowFailure && out.status !== 0) {
      const detail = (out.stderr || out.stdout || "").trim();
      throw new TmuxError(`${this.label} ${args[0]} failed${detail ? `: ${detail}` : ""}`);
    }
    return out;
  }

  hasServer() {
    return this.run(["list-sessions"], { allowFailure: true, readOnly: true }).status === 0;
  }

  /** Can we talk to this tmux at all? One cheap round trip. */
  /**
   * Is the machine reachable? Ask ssh, not tmux: a server with no tmux session
   * running is perfectly reachable, and reporting it as down sends people
   * chasing the wrong thing.
   */
  reachable() {
    if (!this.remote) return true;
    const inv = sshInvocation(this.remote.node, ["true"], { env: this.env, batch: true });
    const res = spawnSync(inv.command, inv.argv, {
      encoding: "utf8",
      env: { ...this.env, ...inv.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    // ssh reserves 255 for its own failures (DNS, auth, timeout, no route).
    return !res.error && res.status !== 255;
  }

  sessionExists(name) {
    return this.run(["has-session", "-t", `=${name}`], { allowFailure: true, readOnly: true }).status === 0;
  }

  /** Map of live tmux sessions → { name, path, created, attached, panes[] }. */
  listSessions() {
    const res = this.run(SESSION_QUERY, { allowFailure: true, readOnly: true });
    return res.status === 0 ? parseSessionLines(res.stdout) : new Map();
  }

  /**
   * The same answer without blocking the event loop — five machines at 300ms
   * each is 1.5s of a status table that could take 300ms.
   */
  async listSessionsAsync() {
    const res = await this.runAsync(SESSION_QUERY);
    return res.status === 0 ? parseSessionLines(res.stdout) : new Map();
  }

  /**
   * The same query, but "I could not ask" is null instead of an empty map:
   * an unreachable machine and an idle one must not look alike.
   */
  async listSessionsStrict() {
    const res = await this.runAsync(SESSION_QUERY);
    if (res.status === 0) return parseSessionLines(res.stdout);
    // "no server running" is an empty machine, not a broken one: tmux exits 1
    // for both, and only the message tells them apart
    if (/no server running|no sessions|error connecting to/i.test(String(res.stderr))) return new Map();
    return null;
  }

  /** Map of attached clients: [{ name, session, activity, user, tty }]. */
  listClients() {
    const res = this.run(
      // who is attached matters before killing anything: tty plus the user
      // that owns it is what "someone else is looking at this" looks like
      CLIENT_QUERY,
      { allowFailure: true, readOnly: true },
    );
    return res.status === 0 ? parseClientLines(res.stdout) : [];
  }

  /** Same, without blocking — status asks every machine at once. */
  async listClientsAsync() {
    const res = await this.runAsync(CLIENT_QUERY);
    return res.status === 0 ? parseClientLines(res.stdout) : [];
  }

  create(session, { argv, env = {} }) {
    const envPairs = Object.entries(env).map(([k, v]) => `${k}=${v}`);
    const command = envPairs.length ? ["env", ...envPairs, ...argv] : argv;
    this.run(["new-session", "-d", "-s", session.tmuxName, "-c", session.cwd, "--", ...command]);
    if (session.remainOnExit) {
      // remain-on-exit is a *window* option: without -w tmux silently ignores it
      // and the session is destroyed the moment the agent exits.
      this.run(["set-option", "-w", "-t", paneTarget(session.tmuxName), "remain-on-exit", "on"], {
        allowFailure: true,
      });
    }
    if (session.log) {
      // `pipe-pane` right after `new-session` can lose the race with the pane
      // becoming addressable; the failure is silent (the session is up, the log
      // simply never grows), so ask, and ask again.
      this.pipeLog(session.tmuxName, session.log);
      for (let attempt = 0; attempt < 3 && !this.pipeActive(session.tmuxName); attempt += 1) {
        // a pipe can be registered against a pane the server is still creating:
        // tmux then believes one is open while nothing is written, so `-o` keeps
        // quiet — force it open instead, and verify.
        sleep(80 + attempt * 80);
        this.pipeLog(session.tmuxName, session.log, { force: true });
      }
    }
  }

  kill(name) {
    return this.run(["kill-session", "-t", `=${name}`], { allowFailure: true });
  }

  capture(name, lines = 200) {
    const start = lines > 0 ? `-${Math.floor(lines)}` : "-";
    const out = this.run(["capture-pane", "-p", "-J", "-t", paneTarget(name), "-S", start], {
      allowFailure: true,
      readOnly: true,
    }).stdout;
    // History capture is padded with blank lines below the cursor: drop them.
    return out.replace(/\s+$/, "");
  }

  /**
   * Type `text` into a session and, unless told otherwise, press Enter.
   *
   * A prompt that spans several lines arrives as one burst of bytes, which pi's
   * TUI reads as a paste: an Enter sent in the same instant is swallowed into
   * that paste and only inserts another newline, so the text sits in the input
   * box unsent. Hence the pause before Enter, and the retry when the screen did
   * not move at all - an accepted Enter always changes what is on the screen.
   */
  sendText(name, text, { enter = true, settleMs = 250, retries = 3 } = {}) {
    // A prompt left in the box by an earlier attempt is not typed twice: it is
    // already in the editor, it only needs the Enter that never landed.
    const waiting = this.editorDraft(name);
    const reused = waiting !== "" && sameDraft(waiting, text);
    if (!reused) {
      this.run(["send-keys", "-t", paneTarget(name), "-l", "--", text]);
      sleep(settleMs);
    }
    if (!enter) return { submitted: false, retries: 0, typed: !reused, reused };

    // An accepted Enter empties the box. "The screen moved" is not a good signal:
    // a working agent redraws its spinner constantly, so it says nothing.
    let attempts = 0;
    for (;;) {
      this.run(["send-keys", "-t", paneTarget(name), "Enter"]);
      sleep(settleMs);
      const left = this.editorDraft(name);
      if (left === "" || !sameDraft(left, text)) {
        return { submitted: true, retries: attempts, typed: !reused, reused };
      }
      // An empty box is the usual proof, but pi can start the turn while the
      // editor still shows the submitted text for a moment. A turn that has
      // begun is proof enough — pressing Enter again would queue a second one.
      if (this.isAgentBusy(name)) return { submitted: true, retries: attempts, typed: !reused, reused, viaBusy: true };
      if (attempts >= retries) break;
      sleep(settleMs * 2 ** attempts);
      attempts += 1;
    }
    return {
      submitted: false,
      retries: attempts,
      typed: !reused,
      reused,
      screen: this.screenSignature(name),
    };
  }

  /** What is waiting in this pane's input box, unsent. */
  editorDraft(name) {
    return editorDraft(this.capture(name, 40));
  }

  /** Is the agent in this pane mid-turn (so typing would only pile up)? */
  isAgentBusy(name) {
    return looksBusy(this.capture(name, 30));
  }

  /** What the last few visible lines look like, with colours and padding gone. */
  screenSignature(name) {
    return screenSignature(this.capture(name, 12));
  }

  /**
   * Is the `log:` pipe still attached? `pipe-pane -o` starts it once; a tmux
   * server restart, a failed respawn or a dead `cat` leaves the setting behind
   * but silent — and "we have logs" is the assumption people act on at 3am.
   */
  pipeActive(name) {
    try {
      const out = this.run(["display-message", "-p", "-t", paneTarget(name), "#{pane_pipe}"]);
      return String(out.stdout ?? "").trim() === "1";
    } catch {
      return false;
    }
  }

  /**
   * One round trip for the two facts that decide whether "we still have logs"
   * is true: is a pipe attached, and is the pane already dead (a dead pane has
   * no pipe, and that is the drift check's business, not this one's).
   */
  paneState(name) {
    try {
      const out = this.run(["list-panes", "-t", `=${name}:`, "-F", "#{pane_dead} #{pane_pipe}"]);
      const [dead, pipe] = String(out.stdout ?? "").trim().split(/\s+/);
      return { exists: true, dead: dead === "1", pipe: pipe === "1" };
    } catch {
      return { exists: false, dead: false, pipe: false };
    }
  }

  pipeLog(name, path, { force = false } = {}) {
    const flags = force ? [] : ["-o"];
    this.run(["pipe-pane", ...flags, "-t", paneTarget(name), `cat >> '${String(path).replace(/'/g, `'\\''`)}'`], {
      allowFailure: true,
      stdinInherit: true,
    });
  }

  /** Attach in the foreground; returns tmux's exit code. */
  attach(name) {
    // Remote attach needs a remote tty: `ssh -t host tmux attach-session -t =name`.
    const spec = this.spawnFor(["attach-session", "-t", `=${name}`], { tty: Boolean(this.remote), batch: false });
    const res = spawnSync(spec.command, spec.argv, { stdio: "inherit", env: spec.env });
    if (res.error && res.error.code === "ENOENT") {
      throw new TmuxError(
        spec.command === "sshpass"
          ? "attaching with a password needs sshpass installed"
          : this.remote
            ? "ssh is not installed (or not on PATH)"
            : "tmux is not installed (or not on PATH)",
      );
    }
    return res.status ?? 1;
  }

}
