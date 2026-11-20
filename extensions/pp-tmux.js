/**
 * pp-tmux — pi extension: drive the surrounding tmux session from slash commands.
 *
 *   /pp-ls                  pick a tmux session (like Ctrl-b s) and switch to it
 *   /pp-sw <name>           switch straight to a session (like Ctrl-b s + Enter)
 *   /pp-quit                detach this client, session and pi keep running (Ctrl-b d)
 *   /pp-status              where am I: session, pane, cwd, pi session, remote-pi name
 *   /pp-peek [name] [-n N]  last N lines of another session's pane (default 30)
 *
 * Plus one model-facing tool, `schedule`: it lets the agent queue a prompt to be
 * typed into a session later ("tomorrow at 9, tell me about the build"), which
 * is the only part of pp the LLM has to reach for on its own.
 *
 * Install with `pi install npm:pi-farm`, or try it once with `pi -e npm:pi-farm`.
 */
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { Box, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

import {
  SEP,
  formatSessionLabel,
  formatStatusLines,
  matchSessionName,
  parsePeekArgs,
  parseTmuxEnv,
  pickClient,
  sessionNameFromLabel,
  trimCapture,
} from "../src/ppui.js";

const execFileAsync = promisify(execFile);

function packageVersion() {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    return JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")).version ?? "?";
  } catch {
    return "?";
  }
}

async function tmux(args) {
  try {
    const { stdout } = await execFileAsync("tmux", args, { maxBuffer: 16 * 1024 * 1024 });
    return stdout;
  } catch (error) {
    const detail = String(error?.stderr ?? "").trim() || String(error?.message ?? error).trim();
    throw new Error(detail || `tmux ${args[0] ?? ""} failed`);
  }
}

function toRows(output) {
  return String(output ?? "")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => line.split(SEP));
}

async function currentSession() {
  return (await tmux(["display-message", "-p", "#S"])).trim();
}

async function readSessions() {
  const sessionFormat = ["#{session_name}", "#{session_attached}", "#{session_windows}", "#{session_activity}"].join(SEP);
  const paneFormat = ["#{session_name}", "#{pane_current_path}", "#{pane_active}", "#{pane_dead}", "#{pane_current_command}"].join(SEP);
  const [sessionsOut, panesOut, current] = await Promise.all([
    tmux(["list-sessions", "-F", sessionFormat]),
    tmux(["list-panes", "-a", "-F", paneFormat]),
    currentSession(),
  ]);
  const panes = new Map();
  for (const [session, path, active, dead, command] of toRows(panesOut)) {
    if (active !== "1" && panes.has(session)) continue;
    panes.set(session, { path, dead: dead === "1", command });
  }
  const list = toRows(sessionsOut).map(([name, attached, windows, activity]) => ({
    name,
    attached: Number.parseInt(attached ?? "0", 10) || 0,
    windows: Number.parseInt(windows ?? "0", 10) || 0,
    activity: Number.parseInt(activity ?? "0", 10) || 0,
    path: panes.get(name)?.path ?? "",
    dead: panes.get(name)?.dead ?? false,
    command: panes.get(name)?.command ?? "",
    current: name === current,
  }));
  list.sort((a, b) => Number(b.current) - Number(a.current) || b.activity - a.activity);
  return list;
}

async function readClients() {
  const out = await tmux(["list-clients", "-F", ["#{client_name}", "#{client_session}", "#{client_activity}"].join(SEP)]);
  return toRows(out).map(([name, session, activity]) => ({
    name,
    session,
    activity: Number.parseInt(activity ?? "0", 10) || 0,
  }));
}

/** The client most likely looking at `session` (used to switch/detach it explicitly). */
async function attachedClient(session) {
  const clients = await readClients().catch(() => []);
  return { client: pickClient(clients, session), total: clients.length };
}

function remotePiInfo(cwd) {
  try {
    const file = join(cwd, ".pi", "remote-pi", "config.json");
    const config = JSON.parse(readFileSync(file, "utf8"));
    const name = typeof config.agent_name === "string" ? config.agent_name : "";
    if (!name) return "no agent_name in .pi/remote-pi/config.json";
    const relay = config.auto_start_relay === false ? "relay off" : "relay on";
    return `${name}  (${cwd}@${name}, ${relay})`;
  } catch {
    return "not configured in this directory";
  }
}

/** The extension only makes sense inside a tmux pane. */
function tmuxContext() {
  const info = parseTmuxEnv(process.env.TMUX);
  if (!info) {
    throw new Error("not running inside tmux (TMUX is unset) — /pp-* needs a tmux pane");
  }
  return info;
}

/** `…/--tmp-x--/01a1eeb5…` — the session directory plus a short id. */
function clipPath(path) {
  if (!path) return undefined;
  const parts = String(path).split("/").filter(Boolean);
  const file = parts[parts.length - 1] ?? "";
  const dir = parts[parts.length - 2] ?? "";
  const match = file.match(/_([0-9a-f-]+)\.jsonl$/);
  const id = match ? match[1].slice(0, 8) : file.slice(0, 8);
  return dir ? `…/${dir}/${id}…` : `…${id}…`;
}

function sessionCompletions(prefix) {
  return readSessions()
    .then((sessions) => {
      const items = sessions.map((session) => ({ value: session.name, label: formatSessionLabel(session) }));
      const filtered = items.filter((item) => item.value.startsWith(prefix ?? ""));
      return filtered.length > 0 ? filtered : null;
    })
    .catch(() => null);
}

/** Switch the client that is looking at our session to `target`. */
async function switchClient(ctx, target) {
  const session = await currentSession();
  const { client, total } = await attachedClient(session);
  if (!client) {
    const why = total === 0 ? "no tmux client is attached" : `the attached client is on another session`;
    ctx.ui.notify(`cannot switch: ${why} — attach first (pp attach ${session})`, "warning");
    return;
  }
  await tmux(["switch-client", "-c", client, "-t", target]);
}

export default function ppTmux(pi) {
  const report = (ctx, title, body) => {
    const text = String(body ?? "");
    // Print mode has no transcript: write the report to stdout so scripts can use
    // `pi -p "/pp-status"` (JSON mode stays untouched).
    if (!ctx.hasUI && ctx.mode === "print") {
      process.stdout.write(`${title}\n${text}\n`);
      return;
    }
    pi.appendEntry("pp-report", { title, body: text });
  };

  pi.registerEntryRenderer("pp-report", (entry, _options, theme) => {
    const data = entry.data ?? {};
    const box = new Box(0, 0, (text) => theme.bg("customMessageBg", text));
    box.addChild(new Text(theme.bold(data.title ?? "pp")));
    box.addChild(new Text(theme.fg("dim", String(data.body ?? ""))));
    return box;
  });

  const command = (name, definition) => {
    const handler = definition.handler;
    pi.registerCommand(name, {
      ...definition,
      handler: async (args, ctx) => {
        try {
          await handler(args, ctx);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (!ctx.hasUI && ctx.mode === "print") {
            // no TUI to notify: surface the failure to the shell instead of exiting 0
            process.stderr.write(`pp: ${message}\n`);
            process.exitCode = 1;
            return;
          }
          ctx.ui.notify(message, "error");
        }
      },
    });
  };

  command("pp-ls", {
    description: "List tmux sessions and switch to the one you pick (Ctrl-b s)",
    handler: async (_args, ctx) => {
      tmuxContext();
      const sessions = await readSessions();
      if (sessions.length === 0) {
        ctx.ui.notify("no tmux sessions", "warning");
        return;
      }
      const labels = sessions.map(formatSessionLabel);
      if (!ctx.hasUI) {
        report(ctx, "tmux sessions", labels.join("\n"));
        return;
      }
      const choice = await ctx.ui.select("tmux sessions — Enter to switch, Esc to stay", labels);
      if (!choice) return;
      const name = sessionNameFromLabel(choice);
      const session = sessions.find((item) => item.name === name);
      if (!session) return;
      if (session.current) {
        ctx.ui.notify(`${name} is the current session`, "info");
        return;
      }
      await switchClient(ctx, session.current ? name : name);
    },
  });

  command("pp-sw", {
    description: "Switch this client to another tmux session (Ctrl-b s + Enter)",
    getArgumentCompletions: sessionCompletions,
    handler: async (args, ctx) => {
      tmuxContext();
      const query = String(args ?? "").trim();
      if (!query) {
        ctx.ui.notify("usage: /pp-sw <session>   (or /pp-ls to pick from a list)", "warning");
        return;
      }
      const sessions = await readSessions();
      const resolved = matchSessionName(sessions.map((session) => session.name), query);
      if (resolved.error) {
        ctx.ui.notify(resolved.error, "error");
        return;
      }
      const session = sessions.find((item) => item.name === resolved.name);
      if (session?.current) {
        ctx.ui.notify(`${session.name} is already the current session`, "info");
        return;
      }
      await switchClient(ctx, resolved.name);
    },
  });

  command("pp-quit", {
    description: "Detach this client from tmux — the session and pi keep running (Ctrl-b d)",
    handler: async (_args, ctx) => {
      const info = tmuxContext();
      const session = await currentSession();
      const clients = await readClients().catch(() => []);
      const client = pickClient(clients, session);
      if (client) await tmux(["detach-client", "-t", client]);
      else await tmux(["detach-client", "-s", session]);
      pi.appendEntry("pp-quit", { at: new Date().toISOString(), session, client, socket: info.socketPath });
      if (ctx.hasUI) ctx.ui.notify(`detached from ${session} — it keeps running`, "info");
    },
  });

  command("pp-status", {
    description: "Show the tmux session, pane, cwd, pi session and remote-pi name of this agent",
    handler: async (_args, ctx) => {
      const info = tmuxContext();
      const session = await currentSession();
      const [window, paneId, clients] = await Promise.all([
        tmux(["display-message", "-p", "#{window_index}:#{window_name}"]),
        tmux(["display-message", "-p", "#{pane_id}"]),
        readClients().catch(() => []),
      ]);
      const attached = clients.filter((client) => client.session === session);
      const lines = formatStatusLines({
        session,
        window: window.trim(),
        pane: paneId.trim(),
        cwd: process.cwd(),
        clients: `${attached.length} attached${attached.length ? ` (${attached.map((client) => client.name).join(", ")})` : ""}`,
        socketPath: info.socketPath,
        piSessionName: pi.getSessionName?.() ?? undefined,
        piSessionId: ctx.sessionManager?.getSessionId?.() ?? undefined,
        piSessionFile: clipPath(ctx.sessionManager?.getSessionFile?.()),
        remotePi: remotePiInfo(process.cwd()),
        ppVersion: packageVersion(),
      });
      report(ctx, `pp status — ${session}`, lines.join("\n"));
    },
  });

  command("pp-peek", {
    description: "Show the last lines of another tmux session without switching to it",
    getArgumentCompletions: sessionCompletions,
    handler: async (args, ctx) => {
      tmuxContext();
      const parsed = parsePeekArgs(args);
      if (parsed.error) {
        ctx.ui.notify(`${parsed.error}   usage: /pp-peek [session] [-n N]`, "error");
        return;
      }
      let target = parsed.target;
      if (target) {
        const sessions = await readSessions();
        const resolved = matchSessionName(sessions.map((session) => session.name), target);
        if (resolved.error) {
          ctx.ui.notify(resolved.error, "error");
          return;
        }
        target = resolved.name;
      } else {
        target = await currentSession();
      }
      const captured = await tmux(["capture-pane", "-p", "-J", "-t", `=${target}:`, "-S", `-${parsed.lines}`]);
      const text = trimCapture(captured, parsed.lines);
      report(ctx, `pp peek — ${target} (last ${parsed.lines} lines)`, text === "" ? "(pane is empty)" : text);
    },
  });

  // ---------------------------------------------------------- scheduled prompts
  //
  // Everything above is user-facing (`/pp-*`). This tool is the opposite: it is
  // how the *model* learns that scheduling exists. Slash commands never enter
  // the model's context, so without a registered tool "明天早上九点提醒我"
  // would only produce a promise, not a job.
  const cliPath = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "pp.js");

  pi.registerTool({
    name: "schedule",
    label: "Schedule",
    description:
      "Queue a prompt to be typed into a tmux session at a later time, or repeatedly. " +
      "Use it whenever the user asks to be reminded, to be told or woken about something later, " +
      "or to have something happen again on a schedule — 明天早上, 今晚十点, 半小时后提醒我, " +
      "每天九点, 每 5 分钟, 每周一、周二、周三. " +
      "The delivered text arrives in that session as a normal user message, so the agent living there " +
      "does the work at that moment. " +
      "Resolve any relative time to an absolute ISO 8601 local timestamp FIRST (run `date` and do the " +
      "arithmetic; never guess), then pass it as `at`. For repeating schedules prefer `cron` " +
      "(five fields: minute hour day month weekday — `*/5 * * * *` is every five minutes, " +
      "`0 9 * * 1,2,3` is Monday/Tuesday/Wednesday at 09:00). " +
      "Returns the job id, which can be cancelled later with `pp cron rm <id>`.",
    parameters: Type.Object({
      prompt: Type.Optional(
        Type.String({ description: "Text to type into the session at that time. Omit when using command." }),
      ),
      command: Type.Optional(
        Type.String({ description: "Shell command to run instead of typing into a session (output goes to the pp cron log)." }),
      ),
      at: Type.Optional(
        Type.String({ description: "Absolute local time, ISO 8601 (e.g. 2026-11-21T09:00). Compute it from `date`, do not guess." }),
      ),
      every: Type.Optional(Type.String({ description: "Fixed interval instead of a wall clock time: 30s, 5m, 2h, 1d." })),
      cron: Type.Optional(
        Type.String({ description: "Five-field cron expression for repeating schedules, e.g. '*/5 * * * *' or '0 9 * * 1,2,3'." }),
      ),
      session: Type.Optional(
        Type.String({ description: "Target session name or number; defaults to the tmux session this conversation runs in." }),
      ),
      start: Type.Optional(
        Type.Boolean({ description: "Start the session first if it is not running when the job fires (default false)." }),
      ),
      catch_up: Type.Optional(
        Type.String({ description: "How late a missed run may still fire, e.g. 2h (default 2h; machine was off)." }),
      ),
    }),
    async execute(_toolCallId, params) {
      if (!params.prompt && !params.command) {
        throw new Error("schedule needs either a prompt to deliver or a command to run");
      }
      if (params.prompt && params.command) {
        throw new Error("schedule takes either prompt or command, not both");
      }
      const args = [cliPath, "cron", "add", "--json"];
      const session = params.session ?? (await currentSession().catch(() => null));
      if (params.prompt) {
        if (session) args.push("--session", session);
      }
      if (params.at) args.push("--at", params.at);
      if (params.every) args.push("--every", params.every);
      if (params.cron) args.push("--cron", params.cron);
      if (params.command) args.push("--command", params.command);
      if (params.start) args.push("--start");
      if (params.catch_up) args.push("--catch-up", params.catch_up);
      if (params.prompt) args.push(params.prompt);

      let stdout;
      try {
        ({ stdout } = await execFileAsync(process.execPath, args, { maxBuffer: 1 << 20 }));
      } catch (error) {
        const detail = `${error.stderr ?? ""}`.trim() || error.message;
        throw new Error(`pp cron add failed: ${detail}`);
      }
      const created = JSON.parse(stdout.trim() || "{}");
      const where = created.session ? `session ${created.session}` : `$ ${params.command}`;
      return {
        content: [
          {
            type: "text",
            text: `scheduled ${created.id} (${created.schedule}) → ${where}; next run ${created.next ?? "never"}. Cancel with: pp cron rm ${created.id}`,
          },
        ],
        details: created,
      };
    },
  });
}
