import { spawnSync } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";

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

const FIELD_SEP = "\u001f";

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
  constructor({ socket = null, dryRun = false, verbose = false, env = process.env } = {}) {
    this.socket = socket;
    this.dryRun = dryRun;
    this.verbose = verbose;
    this.env = env;
  }

  args(args) {
    return this.socket ? ["-L", this.socket, ...args] : [...args];
  }

  /**
   * Run tmux; throws on non-zero unless `allowFailure`. Read-only queries pass
   * `readOnly: true` so `--dry-run` can still report real session state.
   */
  run(args, { allowFailure = false, capture = true, readOnly = false } = {}) {
    const full = this.args(args);
    if (this.dryRun && !readOnly) {
      if (this.verbose) process.stderr.write(`[dry-run] tmux ${full.join(" ")}\n`);
      return { status: 0, stdout: "", stderr: "" };
    }
    if (this.verbose) process.stderr.write(`+ tmux ${full.join(" ")}\n`);
    const res = spawnSync("tmux", full, {
      encoding: "utf8",
      env: this.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (res.error && res.error.code === "ENOENT") {
      throw new TmuxError("tmux is not installed (or not on PATH)");
    }
    const out = {
      status: res.status ?? 1,
      stdout: capture ? (res.stdout ?? "") : "",
      stderr: capture ? (res.stderr ?? "") : "",
    };
    if (!allowFailure && out.status !== 0) {
      const detail = (out.stderr || out.stdout || "").trim();
      throw new TmuxError(`tmux ${args[0]} failed${detail ? `: ${detail}` : ""}`);
    }
    return out;
  }

  hasServer() {
    return this.run(["list-sessions"], { allowFailure: true, readOnly: true }).status === 0;
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
        ].join(FIELD_SEP),
      ],
      { allowFailure: true, readOnly: true },
    );
    const sessions = new Map();
    if (res.status !== 0) return sessions;
    for (const line of res.stdout.split("\n")) {
      if (!line.trim()) continue;
      const [name, paneId, pid, command, dead, path, created, attached] = line.split(FIELD_SEP);
      const entry = sessions.get(name) ?? {
        name,
        path,
        created: Number(created) || 0,
        attached: Number(attached) || 0,
        panes: [],
      };
      entry.panes.push({ id: paneId, pid: Number(pid) || 0, command, dead: dead === "1" });
      sessions.set(name, entry);
    }
    return sessions;
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

  sendText(name, text, { enter = true } = {}) {
    this.run(["send-keys", "-t", paneTarget(name), "-l", "--", text]);
    if (enter) this.run(["send-keys", "-t", paneTarget(name), "Enter"]);
  }

  pipeLog(name, path) {
    this.run(["pipe-pane", "-o", "-t", `=${name}`, `cat >> '${String(path).replace(/'/g, `'\\''`)}'`], {
      allowFailure: true,
    });
  }

  /** Attach in the foreground; returns tmux's exit code. */
  attach(name) {
    const res = spawnSync("tmux", this.args(["attach-session", "-t", `=${name}`]), {
      stdio: "inherit",
      env: this.env,
    });
    if (res.error && res.error.code === "ENOENT") throw new TmuxError("tmux is not installed (or not on PATH)");
    return res.status ?? 1;
  }
}
