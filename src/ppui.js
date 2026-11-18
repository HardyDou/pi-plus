/**
 * Pure helpers behind the `/pp-*` pi extension commands.
 *
 * Kept separate from the extension itself so they can be unit tested without
 * starting pi or tmux.
 */

/** Field separator used when asking tmux for machine-readable output. */
export const SEP = "\u001f";

/**
 * Parse the `TMUX` environment variable: `<socket-path>,<server-pid>,<session-index>`.
 * @returns {{socketPath: string, serverPid: number|null, sessionIndex: number|null}|null}
 */
export function parseTmuxEnv(value) {
  if (typeof value !== "string" || value.trim() === "") return null;
  const parts = value.split(",");
  if (parts.length < 2) return null;
  const socketPath = parts.slice(0, parts.length - 2).join(",");
  const serverPid = Number.parseInt(parts[parts.length - 2], 10);
  const sessionIndex = Number.parseInt(parts[parts.length - 1], 10);
  if (!socketPath) return null;
  return {
    socketPath,
    serverPid: Number.isFinite(serverPid) ? serverPid : null,
    sessionIndex: Number.isFinite(sessionIndex) ? sessionIndex : null,
  };
}

/** Shorten a path to its last two segments: `/a/b/c/d` → `…/c/d`. */
export function shortPath(path, max = 34) {
  if (!path) return "";
  const text = String(path);
  if (text.length <= max) return text;
  const parts = text.split("/").filter(Boolean);
  if (parts.length >= 2) {
    const tail = `…/${parts.slice(-2).join("/")}`;
    if (tail.length <= max) return tail;
  }
  return `…${text.slice(-(max - 1))}`;
}

/** Pad to a visible width (no ANSI involved here). */
function pad(text, width) {
  const value = String(text ?? "");
  if (value.length >= width) return value;
  return value + " ".repeat(width - value.length);
}

/**
 * One row of the `/pp-ls` picker.
 * @param {{name: string, path?: string, windows?: number, attached?: number, current?: boolean, dead?: boolean, command?: string}} info
 */
export function formatSessionLabel(info) {
  const marks = [];
  if (info.current) marks.push("current");
  if (info.dead) marks.push("dead");
  if (info.attached > 1) marks.push(`${info.attached} clients`);
  const suffix = marks.length ? `  (${marks.join(", ")})` : "";
  const windows = Number.isFinite(info.windows) && info.windows > 0 ? `${info.windows}w` : "";
  const name = info.current ? `* ${info.name}` : `  ${info.name}`;
  return `${pad(name, 22)}${pad(shortPath(info.path), 35)}${pad(windows, 4)}${suffix}`.trimEnd();
}

/**
 * Parse `#<index>` or a plain name out of the picker label ("* backend  /x  2w  (current)").
 * The index is not used for routing (tmux list order is activity based), so we
 * only take the name.
 */
export function sessionNameFromLabel(label) {
  const text = String(label ?? "").replace(/^\s*\*\s*/, "").trim();
  return text.split(/\s{2,}/)[0]?.trim() ?? "";
}

/**
 * Resolve a user supplied session reference against known session names:
 * exact match wins, then case-insensitive exact, then a unique prefix.
 * @returns {{name: string}|{error: string}}
 */
export function matchSessionName(names, query) {
  const wanted = String(query ?? "").trim();
  if (!wanted) return { error: "no session name given" };
  const list = names.filter((name) => typeof name === "string" && name !== "");
  if (list.includes(wanted)) return { name: wanted };
  const lower = wanted.toLowerCase();
  const exact = list.filter((name) => name.toLowerCase() === lower);
  if (exact.length === 1) return { name: exact[0] };
  const prefixed = list.filter((name) => name.toLowerCase().startsWith(lower));
  if (prefixed.length === 1) return { name: prefixed[0] };
  if (prefixed.length > 1) {
    return { error: `"${wanted}" is ambiguous: ${prefixed.slice(0, 5).join(", ")}` };
  }
  return { error: `no tmux session named "${wanted}"` };
}

/**
 * Parse `/pp-peek` arguments: `[session] [-n N] [--lines N] [-nN]`.
 * @returns {{target: string|null, lines: number}|{error: string}}
 */
export function parsePeekArgs(text) {
  const tokens = String(text ?? "").trim().split(/\s+/).filter(Boolean);
  let target = null;
  let lines = 30;
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === "-n" || token === "--lines") {
      const raw = tokens[i + 1];
      if (raw === undefined) return { error: `${token} needs a number` };
      const value = Number.parseInt(raw, 10);
      if (!Number.isFinite(value)) return { error: `${token} needs a number, got "${raw}"` };
      lines = value;
      i += 1;
      continue;
    }
    if (/^-\d+$/.test(token)) {
      lines = Number.parseInt(token.slice(1), 10);
      continue;
    }
    if (/^-n-?\d+$/.test(token)) {
      lines = Number.parseInt(token.slice(2), 10);
      continue;
    }
    if (token.startsWith("-")) return { error: `unknown option ${token}` };
    if (target !== null) return { error: `unexpected argument "${token}"` };
    target = token;
  }
  if (lines < 1 || lines > 500) return { error: "line count must be between 1 and 500" };
  return { target, lines };
}

/** Drop trailing blank lines, then keep the last `lines` lines. */
export function trimCapture(text, lines = 30) {
  const all = String(text ?? "").replace(/\r/g, "").split("\n");
  while (all.length > 0 && all[all.length - 1].trim() === "") all.pop();
  if (all.length <= lines) return all.join("\n");
  return all.slice(all.length - lines).join("\n");
}

/**
 * Pick the client most likely to be "us": the most recently active client
 * attached to `session`.
 * @param {Array<{name: string, session: string, activity?: number}>} clients
 */
export function pickClient(clients, session) {
  const attached = clients.filter((client) => client.session === session);
  if (attached.length === 0) return null;
  const sorted = attached.slice().sort((a, b) => (b.activity ?? 0) - (a.activity ?? 0));
  return sorted[0].name;
}

/** `12:34:56` from a unix timestamp in seconds. */
export function clockTime(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value <= 0) return "";
  const date = new Date(value * 1000);
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

/** Build the `/pp-status` report lines (label + value pairs). */
export function formatStatusLines(info) {
  const rows = [];
  const push = (label, value) => {
    if (value === undefined || value === null || value === "") return;
    rows.push([label, String(value)]);
  };
  push("session", info.session);
  push("window", info.window);
  push("pane", info.pane);
  push("cwd", info.cwd);
  push("clients", info.clients);
  push("socket", info.socketPath);
  push("pi session", info.piSessionName);
  push("pi id", info.piSessionId);
  push("pi file", info.piSessionFile);
  push("remote-pi", info.remotePi);
  push("pp", info.ppVersion);
  const width = rows.reduce((max, [label]) => Math.max(max, label.length), 0);
  return rows.map(([label, value]) => `${label.padEnd(width)}  ${value}`);
}
