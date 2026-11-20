import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

const state = mkdtempSync(join(tmpdir(), "pp-todo-"));
process.env.XDG_STATE_HOME = state;

const {
  addTodo,
  agoString,
  clearTodos,
  filterTodos,
  looksLikeQuestion,
  readTodos,
  removeTodo,
  resolveTodo,
  setTodoState,
  settledMode,
  sortTodos,
  todoRow,
  todosPath,
  TodoError,
} = await import("../src/todo.js");

before(() => {
  process.env.XDG_STATE_HOME = state;
});

after(() => {
  rmSync(state, { recursive: true, force: true });
});

function reset() {
  clearTodos({ doneOnly: false });
}

test("todos.json lives under XDG_STATE_HOME", () => {
  assert.equal(todosPath({ XDG_STATE_HOME: "/x" }), "/x/pi-plus/todos.json");
  assert.match(todosPath({ HOME: "/home/u" }), /\/home\/u\/\.local\/state\/pi-plus\/todos\.json$/);
});

test("adding a todo keeps the session, kind and title", () => {
  reset();
  const { todo, created } = addTodo({ session: "backend", kind: "prompt", title: "pick a branch", body: "select" });
  assert.equal(created, true);
  assert.match(todo.id, /^[0-9a-f]{6}$/);
  assert.equal(todo.session, "backend");
  assert.equal(todo.kind, "prompt");
  assert.equal(todo.state, "new");
  assert.equal(readTodos().length, 1);
});

test("the same open question is refreshed, not duplicated", () => {
  reset();
  addTodo({ session: "docs", kind: "prompt", title: "delete the draft?" });
  const again = addTodo({ session: "docs", kind: "prompt", title: "delete the draft?", body: "still waiting" });
  assert.equal(again.created, false);
  assert.equal(readTodos().length, 1);
  assert.equal(readTodos()[0].body, "still waiting");
});

test("a finished todo can be asked again", () => {
  reset();
  const first = addTodo({ session: "ops", kind: "settled", title: "restart now?" }).todo;
  const todos = readTodos();
  setTodoState(todos, todos[0], "done");
  const second = addTodo({ session: "ops", kind: "settled", title: "restart now?" });
  assert.equal(second.created, true, "a new occurrence after done is a new todo");
  assert.notEqual(second.todo.id, first.id);
});

test("refs resolve by index and by id prefix", () => {
  reset();
  const a = addTodo({ session: "one", kind: "manual", title: "older", at: "2026-11-01T00:00:00Z" }).todo;
  const b = addTodo({ session: "two", kind: "manual", title: "newer", at: "2026-11-02T00:00:00Z" }).todo;
  const todos = readTodos();
  assert.equal(resolveTodo(todos, "1").todo.id, b.id, "newest is #1");
  assert.equal(resolveTodo(todos, "2").todo.id, a.id);
  const fake = [
    { id: "a1b2c3", session: "s", kind: "manual", title: "x", state: "new", createdAt: "2026-11-01T00:00:00Z" },
    { id: "971234", session: "s", kind: "manual", title: "y", state: "new", createdAt: "2026-10-01T00:00:00Z" },
  ];
  assert.equal(resolveTodo(fake, "a1b").todo.id, "a1b2c3", "id prefix wins for a non-numeric ref");
  assert.equal(resolveTodo(fake, "971234").todo.id, "971234", "a numeric id longer than an index is an id");
  assert.throws(() => resolveTodo(fake, "971"), /no todo #971 .*id prefix/, "a short number is an index, not an id");
  assert.throws(() => resolveTodo(todos, "9"), /no todo #9/);
  assert.throws(() => resolveTodo(todos, "zzz"), /no todo with id "zzz"/);
  assert.throws(() => resolveTodo(todos, ""), /which todo/);
});

test("ambiguous id prefixes are rejected", () => {
  const todos = [
    { id: "abc111", session: "s", kind: "manual", title: "a", state: "new", createdAt: "2026-11-01T00:00:00Z" },
    { id: "abc222", session: "s", kind: "manual", title: "b", state: "new", createdAt: "2026-11-01T00:00:00Z" },
  ];
  assert.throws(() => resolveTodo(todos, "abc"), /matches 2 todos/);
});

test("done rows hide from ls unless --all", () => {
  reset();
  addTodo({ session: "s", kind: "manual", title: "open" });
  const closed = addTodo({ session: "s", kind: "manual", title: "closed" }).todo;
  const todos = readTodos();
  setTodoState(todos, todos.find((todo) => todo.id === closed.id), "done");
  const visible = filterTodos(readTodos());
  assert.deepEqual(visible.map((todo) => todo.title), ["open"]);
  assert.equal(filterTodos(readTodos(), { all: true }).length, 2);
  assert.equal(filterTodos(readTodos(), { session: "nope" }).length, 0);
});

test("clear keeps open todos unless forced", () => {
  reset();
  addTodo({ session: "s", kind: "manual", title: "open" });
  const closed = addTodo({ session: "s", kind: "manual", title: "closed" }).todo;
  const todos = readTodos();
  setTodoState(todos, todos.find((todo) => todo.id === closed.id), "done");
  assert.equal(clearTodos(), 1);
  assert.deepEqual(readTodos().map((todo) => todo.title), ["open"]);
  assert.equal(clearTodos({ doneOnly: false }), 1);
  assert.equal(readTodos().length, 0);
});

test("removeTodo drops one row", () => {
  reset();
  const keep = addTodo({ session: "s", kind: "manual", title: "keep" }).todo;
  const drop = addTodo({ session: "s", kind: "manual", title: "drop" }).todo;
  removeTodo(readTodos(), drop);
  assert.deepEqual(readTodos().map((todo) => todo.id), [keep.id]);
});

test("a missing session is refused and unknown kinds fall back to manual", () => {
  reset();
  assert.throws(() => addTodo({ kind: "manual", title: "x" }), /needs the session/);
  assert.equal(addTodo({ session: "s", kind: "bogus", title: "x" }).todo.kind, "manual");
});

test("only a trailing question counts as 'needs an answer'", () => {
  assert.equal(looksLikeQuestion("Done. Should I push it?"), true);
  assert.equal(looksLikeQuestion("都跑完了，需要我删掉这个分支吗？"), true);
  assert.equal(looksLikeQuestion("请确认一下配置"), true);
  assert.equal(looksLikeQuestion("All tests passed."), false);
  assert.equal(looksLikeQuestion(""), false);
});

test("settled mode comes from PP_TODO_SETTLED with a safe default", () => {
  assert.equal(settledMode({}), "question");
  assert.equal(settledMode({ PP_TODO_SETTLED: "ALWAYS" }), "always");
  assert.equal(settledMode({ PP_TODO_SETTLED: "nonsense" }), "question");
});

test("rows carry an age and a liveness flag", () => {
  const now = Date.parse("2026-11-20T12:00:00Z");
  const todo = { id: "aaaaaa", session: "backend", kind: "prompt", title: "t", state: "new", createdAt: "2026-11-20T11:57:00Z" };
  const row = todoRow(todo, { now, live: new Map([["backend", {}]]) });
  assert.equal(row.age, "3m");
  assert.equal(row.live, true);
  assert.equal(todoRow(todo, { now }).live, null);
  assert.equal(agoString("2026-11-20T10:00:00Z", now), "2h");
  assert.equal(agoString("2026-11-18T12:00:00Z", now), "2d");
});

test("sorted newest first and stable across state changes", () => {
  const todos = [
    { id: "b", createdAt: "2026-11-01T00:00:00Z", state: "new" },
    { id: "a", createdAt: "2026-11-03T00:00:00Z", state: "done" },
  ];
  assert.deepEqual(sortTodos(todos).map((todo) => todo.id), ["a", "b"]);
});
