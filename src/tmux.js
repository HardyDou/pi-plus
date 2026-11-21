import { spawnSync } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { shellQuote } from "./config.js";

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

const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g;

/** The rule lines a pi TUI draws above and below its input box. */
function isRule(line) {
  return /^─{10,}$/.test(line.trim());
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
  run(args, { allowFailure = false, capture = true, readOnly = false } = {}) {
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
      stdio: ["ignore", "pipe", "pipe"],
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
    const res = this.run(
      [
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
      ],
      { allowFailure: true, readOnly: true },
    );
    const sessions = new Map();
    if (res.status !== 0) return sessions;
    for (const line of decodeFields(res.stdout).split("\n")) {
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
      entry.panes.push({ id: paneId, pid: Number(pid) || 0, command, dead: dead === "1" });
      sessions.set(name, entry);
    }
    return sessions;
  }

  /** Map of attached clients: [{ name, session, activity }]. */
  listClients() {
    const res = this.run(
      // who is attached matters before killing anything: tty plus the user
      // that owns it is what "someone else is looking at this" looks like
      [
        "list-clients",
        "-F",
        ["#{client_name}", "#{client_session}", "#{client_activity}", "#{client_user}", "#{client_tty}"].join(FIELD_SEP),
      ],
      { allowFailure: true, readOnly: true },
    );
    if (res.status !== 0) return [];
    return res.stdout
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => {
        const [name, session, activity, user, tty] = decodeFields(line).split(FIELD_SEP);
        return { name, session, activity: Number(activity) || 0, user: user || "", tty: tty || "" };
      });
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
      this.pipeLog(session.tmuxName, session.log);
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

  pipeLog(name, path) {
    this.run(["pipe-pane", "-o", "-t", paneTarget(name), `cat >> '${String(path).replace(/'/g, `'\\''`)}'`], {
      allowFailure: true,
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
