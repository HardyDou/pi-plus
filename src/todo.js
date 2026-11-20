import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * The todo list: one flat file of "a session wants a decision from you".
 *
 * Entries come from three places:
 *   prompt  — pi showed a blocking UI prompt (ctx.ui.select/confirm/input/...)
 *   settled — a run finished and the last thing it did was ask something
 *   manual  — `pp todo add`, or the agent calling the `schedule`-style tool
 *
 * Everything is a plain JSON file so a crashed pi process cannot corrupt the
 * list and so the CLI can read it while pi is running.
 */

export const TODO_KINDS = ["prompt", "settled", "manual"];
export const TODO_STATES = ["new", "seen", "done"];
export const DEFAULT_SETTLED_MODE = "question";
export const SETTLED_MODES = ["question", "always", "off"];

export class TodoError extends Error {
  constructor(message) {
    super(message);
    this.name = "TodoError";
  }
}

export function todosPath(env = process.env) {
  const base = env.XDG_STATE_HOME || join(env.HOME || homedir(), ".local", "state");
  return join(base, "pi-plus", "todos.json");
}

export function readTodos(env = process.env) {
  const path = todosPath(env);
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return Array.isArray(parsed?.todos) ? parsed.todos : [];
  } catch {
    return [];
  }
}

export function writeTodos(todos, env = process.env) {
  const path = todosPath(env);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ version: 1, todos }, null, 2)}\n`, "utf8");
  renameSync(tmp, path);
}

export function newTodoId(existing = []) {
  const taken = new Set(existing.map((todo) => todo.id));
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const id = randomBytes(3).toString("hex");
    if (!taken.has(id)) return id;
  }
  return `t${Date.now().toString(36)}`;
}

function clip(text, max) {
  const value = String(text ?? "").replace(/\s+/g, " ").trim();
  return value.length > max ? `${value.slice(0, Math.max(1, max - 1))}…` : value;
}

/** A run that ends in a question is the usual "it wants an answer" case. */
export function looksLikeQuestion(text) {
  const value = String(text ?? "").trim();
  if (!value) return false;
  const lastLine = value.split("\n").map((line) => line.trim()).filter(Boolean).pop() ?? "";
  if (/[?？]\s*$/.test(lastLine)) return true;
  return /(请确认|要不要|是否需要|需要你|需要我|确认一下|可以吗|行吗|confirm\b|shall i\b|should i\b|do you want|want me to)/i.test(lastLine);
}

export function settledMode(env = process.env) {
  const mode = String(env.PP_TODO_SETTLED ?? DEFAULT_SETTLED_MODE).trim().toLowerCase();
  return SETTLED_MODES.includes(mode) ? mode : DEFAULT_SETTLED_MODE;
}

/**
 * Add one todo. Re-asking the same thing does not create a second row: an
 * unfinished entry with the same session, kind and title is refreshed instead.
 */
export function addTodo(input, env = process.env) {
  const session = String(input.session ?? "").trim();
  if (!session) throw new TodoError("a todo needs the session it belongs to");
  const kind = TODO_KINDS.includes(input.kind) ? input.kind : "manual";
  const title = clip(input.title ?? input.body ?? "needs attention", 120);
  const body = clip(input.body ?? "", 2000);
  const at = new Date(input.at ?? Date.now()).toISOString();
  const todos = readTodos(env);
  const same = todos.find((todo) => todo.session === session && todo.kind === kind && todo.title === title && todo.state !== "done");
  if (same) {
    same.body = body || same.body;
    same.updatedAt = at;
    writeTodos(todos, env);
    return { todo: same, created: false };
  }
  const todo = {
    id: newTodoId(todos),
    session,
    kind,
    title,
    body,
    state: "new",
    createdAt: at,
    updatedAt: at,
  };
  todos.push(todo);
  writeTodos(todos, env);
  return { todo, created: true };
}

/** Stable order: newest first, so an index stays put between two runs. */
export function sortTodos(todos) {
  return [...todos].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)) || String(a.id).localeCompare(String(b.id)));
}

export function filterTodos(todos, { session, all = false } = {}) {
  return sortTodos(todos).filter((todo) => {
    if (!all && todo.state === "done") return false;
    if (session && todo.session !== session) return false;
    return true;
  });
}

/**
 * Resolve `pp todo done 3` / `pp todo done 4f2a1c`. Indexes are 1-based over the
 * full newest-first list (done rows included), so a ref means one thing only.
 */
export function resolveTodo(todos, ref) {
  const value = String(ref ?? "").trim();
  if (!value) throw new TodoError("which todo? pass the # from `pp todo ls`");
  const sorted = sortTodos(todos);
  // A short number is an index; a long one is almost certainly a pasted id (ids
  // are hex, and half of them start with a digit).
  if (/^\d+$/.test(value) && value.length <= 3) {
    const index = Number(value);
    if (index < 1 || index > sorted.length) {
      const hint = /^\d+$/.test(value) ? " — a number is an index; for an id prefix use at least 4 characters" : "";
      throw new TodoError(
        `no todo #${index} (there ${sorted.length === 1 ? "is 1 todo" : `are ${sorted.length}`})${hint}`,
      );
    }
    return { todo: sorted[index - 1], index };
  }
  const matches = sorted.filter((todo) => todo.id === value || todo.id.startsWith(value));
  if (matches.length === 0 && /^\d+$/.test(value)) {
    const index = Number(value);
    if (index >= 1 && index <= sorted.length) return { todo: sorted[index - 1], index };
  }
  if (matches.length === 1) return { todo: matches[0], index: sorted.indexOf(matches[0]) + 1 };
  if (matches.length > 1) throw new TodoError(`"${value}" matches ${matches.length} todos; use more characters`);
  throw new TodoError(`no todo with id "${value}"`);
}

export function setTodoState(todos, todo, state, env = process.env) {
  if (!TODO_STATES.includes(state)) throw new TodoError(`state must be one of ${TODO_STATES.join(", ")}`);
  todo.state = state;
  todo.updatedAt = new Date().toISOString();
  if (state === "done") todo.doneAt = todo.updatedAt;
  else delete todo.doneAt;
  writeTodos(todos, env);
  return todo;
}

export function removeTodo(todos, todo, env = process.env) {
  const next = todos.filter((item) => item.id !== todo.id);
  writeTodos(next, env);
  return next;
}

/** Drop finished rows (and optionally everything). */
export function clearTodos({ doneOnly = true } = {}, env = process.env) {
  const todos = readTodos(env);
  const next = doneOnly ? todos.filter((todo) => todo.state !== "done") : [];
  const removed = todos.length - next.length;
  writeTodos(next, env);
  return removed;
}

/** "3m" / "2h" / "5d" — how long this has been waiting. */
export function agoString(from, now = Date.now()) {
  const ms = Math.max(0, now - new Date(from).getTime());
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

export function todoRow(todo, { now = Date.now(), live = null } = {}) {
  return {
    id: todo.id,
    state: todo.state,
    age: agoString(todo.createdAt, now),
    session: todo.session,
    kind: todo.kind,
    title: todo.title,
    body: todo.body,
    live: live ? live.has(todo.session) : null,
  };
}

/** Everything this session was waiting on is settled once it runs again. */
export function closeSessionTodos(session, env = process.env, reason = "answered") {
  const todos = readTodos(env);
  const open = todos.filter((todo) => todo.session === session && todo.state !== "done");
  if (open.length === 0) return 0;
  const at = new Date().toISOString();
  for (const todo of open) {
    todo.state = "done";
    todo.doneAt = at;
    todo.updatedAt = at;
    todo.closedBy = reason;
  }
  writeTodos(todos, env);
  return open.length;
}
