/**
 * Handing a file to a session.
 *
 * A terminal can only carry text: dragging a file into iTerm2 pastes its path,
 * and that path means nothing on the machine the session actually runs on. So
 * the file has to travel first and the path has to be the one that machine
 * sees — which is what this module does, in the two shapes that matter.
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";

import { sshInvocation } from "./nodes.js";
import { stateDir } from "./audit.js";

export class FileError extends Error {
  constructor(message) {
    super(message);
    this.name = "FileError";
  }
}

/** Where dropped files land on this machine (and on every node, same rule). */
export function dropDirFor(session, env = process.env) {
  return join(stateDir(env), "drops", session);
}

/** The name to use on the far side: the same one, unless something is already there. */
export function freeName(dir, name, exists = (path) => existsSync(path)) {
  const base = basename(name) || "file";
  if (!exists(join(dir, base))) return base;
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const tail = dot > 0 ? base.slice(dot) : "";
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${stem}-${index}${tail}`;
    if (!exists(join(dir, candidate))) return candidate;
  }
  throw new FileError(`cannot find a free name for ${base} in ${dir}`);
}

/**
 * Copy a local file into the drop directory of a session on this machine.
 * Returns the absolute path the agent should be told about.
 */
export function dropLocal(session, file, env = process.env) {
  if (!existsSync(file)) throw new FileError(`no such file: ${file}`);
  const stat = statSync(file);
  if (!stat.isFile()) throw new FileError(`not a regular file: ${file}`);
  const dir = dropDirFor(session, env);
  mkdirSync(dir, { recursive: true });
  const name = freeName(dir, basename(file));
  const target = join(dir, name);
  copyFileSync(file, target);
  return { path: target, name, bytes: stat.size };
}

/**
 * Copy a local file onto a machine and return the path *that machine* sees.
 *
 * `cat > file` over ssh rather than scp: it needs nothing installed on the far
 * side beyond a shell, which is the same promise the rest of pp makes.
 */
export function dropRemote(node, session, file, { env = process.env, timeout = 120000 } = {}) {
  if (!existsSync(file)) throw new FileError(`no such file: ${file}`);
  const stat = statSync(file);
  if (!stat.isFile()) throw new FileError(`not a regular file: ${file}`);
  const name = basename(file) || "file";
  const dir = dropDirFor(session, env);
  const remote = `mkdir -p ${JSON.stringify(dir)} && cat > ${JSON.stringify(join(dir, name))}`;
  const inv = sshInvocation(node, [remote], { env, batch: true });
  const fd = spawnSync("sh", ["-c", `cat ${JSON.stringify(file)}`], { stdio: ["ignore", "pipe", "ignore"] });
  const result = spawnSync(inv.command, inv.argv, {
    input: fd.stdout ?? "",
    env: { ...process.env, ...(inv.env ?? {}) },
    encoding: "utf8",
    timeout,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw new FileError(`could not reach ${node.name}: ${result.error.message}`);
  if (result.status !== 0) {
    const said = String(result.stderr ?? "").trim().split("\n").slice(-1)[0] || `exit ${result.status}`;
    throw new FileError(`${node.name} refused it: ${said}`);
  }
  return { path: join(dir, name), name, bytes: stat.size };
}

/**
 * The file on the clipboard, if the desktop can tell us.
 *
 * Copying a file in Finder or Files puts a *reference* on the clipboard, not
 * the bytes — which is exactly what we need: pp copies it afterwards. Reading
 * the clipboard is the only platform-specific part, so it is isolated here and
 * simply returns null where there is no desktop to ask.
 */
export function clipboardFile(env = process.env, run = spawnSync) {
  const attempts = [];
  if (process.platform === "darwin") {
    attempts.push(["osascript", ["-e", 'POSIX path of (the clipboard as «class furl»)']]);
    attempts.push(["pbpaste", []]);
  } else {
    attempts.push(["wl-paste", ["--no-newline"]]);
    attempts.push(["xclip", ["-selection", "clipboard", "-t", "text/uri-list", "-o"]]);
    attempts.push(["xclip", ["-selection", "clipboard", "-o"]]);
  }
  for (const [command, args] of attempts) {
    const result = run(command, args, { encoding: "utf8", timeout: 5000, env });
    if (result.error || result.status !== 0) continue;
    const said = String(result.stdout ?? "").trim();
    if (!said) continue;
    for (const line of said.split("\n").map((item) => item.trim()).filter(Boolean)) {
      const path = line.startsWith("file://") ? decodeURIComponent(new URL(line).pathname) : line;
      if (path.startsWith("/") || path.startsWith("~")) {
        const expanded = path.startsWith("~") ? join(env.HOME || "", path.slice(1)) : path;
        if (existsSync(expanded)) return expanded;
      }
    }
  }
  return null;
}

/**
 * A path that arrived as keystrokes, which is what a drag-and-drop looks like.
 *
 * iTerm2 does not hand the file over — it types the path into the tty, wrapped
 * in bracketed-paste markers when the program asked for them. So "was a file
 * dropped here" and "did someone type slashes" have to be told apart: a drop is
 * one printable path that exists, not a key press.
 */
export function pastedPath(chunk, { exists = (path) => existsSync(path), home = process.env.HOME } = {}) {
  let text = String(chunk ?? "");
  if (!text) return null;
  text = text.replace(/\u001b\[200~/g, "").replace(/\u001b\[201~/g, "");
  text = text.replace(/[\r\n]+$/, "");
  if (!text || /[\u0000-\u001f\u007f]/.test(text)) return null;
  let candidate = text.trim();
  if (
    (candidate.startsWith('"') && candidate.endsWith('"')) ||
    (candidate.startsWith("'") && candidate.endsWith("'"))
  ) {
    candidate = candidate.slice(1, -1);
  }
  // a shell escape (iTerm2 quotes spaces with backslashes) is still a path
  candidate = candidate.replace(/\\(.)/g, "$1");
  if (candidate.startsWith("file://")) {
    try {
      candidate = decodeURIComponent(new URL(candidate).pathname);
    } catch {
      return null;
    }
  }
  if (!candidate.startsWith("/") && !candidate.startsWith("~")) return null;
  const expanded = candidate.startsWith("~") ? join(home || "", candidate.slice(1)) : candidate;
  // existence is the whole test: it separates "a file was dropped" from
  // "somebody typed slashes". A dropped path may contain spaces, quotes, or
  // backslash escapes — all of which are still just a path to a file.
  if (!exists(expanded)) return null;
  return expanded;
}
