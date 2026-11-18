import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * remote-pi keeps its per-directory agent name in `<cwd>/.pi/remote-pi/config.json`
 * (field `agent_name`); `/remote-pi rename <name>` persists exactly that field.
 * pp writes the same file before launching pi so a fresh session already
 * joins the mesh with the requested name. `remote_pi_mode: env` is the
 * non-invasive alternative: it injects the merged config through
 * REMOTE_PI_DIRECT_CONFIG (which remote-pi gives precedence over the file).
 */
export function remotePiConfigPath(cwd) {
  return join(cwd, ".pi", "remote-pi", "config.json");
}

export function readRemotePiConfig(cwd) {
  const path = remotePiConfigPath(cwd);
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function remotePiEnvConfig(cwd, name) {
  return { ...readRemotePiConfig(cwd), agent_name: name };
}

/** Write `agent_name`, preserving every other key already in the file. */
export function writeRemotePiName(cwd, name) {
  const path = remotePiConfigPath(cwd);
  const next = { ...readRemotePiConfig(cwd), agent_name: name };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return path;
}

export function remotePiConfigExists(cwd) {
  return existsSync(remotePiConfigPath(cwd));
}
