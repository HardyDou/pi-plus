/**
 * Where the last control panel (`pp tui`) lives, so that `/pp-back` and
 * `pp back` can put you in front of it again.
 *
 * It is a one-line file on purpose: the panel is a tmux pane like any other,
 * and once you have switched away from it the only thing anybody needs is
 * "which session/window/pane was it". Staleness is handled by the caller, which
 * checks that the pane is still alive before switching to it.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** `~/.local/state/pi-plus/panel.json` (override with XDG_STATE_HOME). */
export function panelStatePath(env = process.env) {
  const base = env.XDG_STATE_HOME || join(env.HOME || homedir(), ".local", "state");
  return join(base, "pi-plus", "panel.json");
}

export function savePanel(panel, env = process.env) {
  const file = panelStatePath(env);
  mkdirSync(dirname(file), { recursive: true });
  const record = {
    session: String(panel.session ?? ""),
    window: String(panel.window ?? "0"),
    pane: String(panel.pane ?? ""),
    at: new Date().toISOString(),
  };
  writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

export function loadPanel(env = process.env) {
  try {
    const text = readFileSync(panelStatePath(env), "utf8");
    const data = JSON.parse(text);
    if (!data || typeof data.session !== "string" || data.session === "") return null;
    return {
      session: data.session,
      window: String(data.window ?? "0"),
      pane: String(data.pane ?? ""),
      at: typeof data.at === "string" ? data.at : "",
    };
  } catch {
    return null;
  }
}

export function clearPanel(env = process.env) {
  try {
    rmSync(panelStatePath(env), { force: true });
    return true;
  } catch {
    return false;
  }
}

/** Parse `tmux list-panes -a -F '#{pane_id} #{session_name} #{window_index}'`. */
export function findPanelPane(text, panel) {
  if (!panel || !panel.pane) return null;
  for (const line of String(text ?? "").split("\n")) {
    const [pane, session, window] = line.trim().split(/\s+/);
    if (!pane || pane !== panel.pane) continue;
    return { pane, session: session ?? panel.session, window: window ?? panel.window };
  }
  return null;
}
