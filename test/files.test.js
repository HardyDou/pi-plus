import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { dropDirFor, dropLocal, freeName } from "../src/files.js";

test("a dropped file lands under the state dir, named after the session", () => {
  const env = { XDG_STATE_HOME: mkdtempSync(`${tmpdir()}/pp-files-`), HOME: "/home/nobody" };
  const source = join(env.XDG_STATE_HOME, "shot.png");
  writeFileSync(source, "pixels");
  const dropped = dropLocal("risk-pm", source, env);
  assert.equal(dropped.name, "shot.png");
  assert.equal(dropped.path, join(dropDirFor("risk-pm", env), "shot.png"));
  assert.equal(dropped.bytes, 6);
});

test("the same name twice gets a number instead of overwriting", () => {
  const env = { XDG_STATE_HOME: mkdtempSync(`${tmpdir()}/pp-files-`), HOME: "/home/nobody" };
  const source = join(env.XDG_STATE_HOME, "log.txt");
  writeFileSync(source, "one");
  const first = dropLocal("api", source, env);
  writeFileSync(source, "two");
  const second = dropLocal("api", source, env);
  assert.equal(first.name, "log.txt");
  assert.equal(second.name, "log-2.txt");
});

test("freeName keeps the extension and gives up loudly", () => {
  assert.equal(freeName("/x", "a.txt", () => false), "a.txt");
  assert.equal(freeName("/x", "a.txt", (path) => path === "/x/a.txt"), "a-2.txt");
  assert.equal(freeName("/x", "noext", (path) => path === "/x/noext"), "noext-2");
  assert.throws(() => freeName("/x", "noext", () => true), /cannot find a free name/);
});

test("a dropped path is one path that exists, not a burst of keys", async () => {
  const { pastedPath } = await import("../src/files.js");
  const exists = (path) => path === "/tmp/shot.png" || path === "/home/me/a b.png";
  assert.equal(pastedPath("/tmp/shot.png\n", { exists }), "/tmp/shot.png");
  assert.equal(pastedPath("\u001b[200~/tmp/shot.png\u001b[201~", { exists }), "/tmp/shot.png");
  assert.equal(pastedPath("/nope.png", { exists }), null);
  assert.equal(pastedPath("q", { exists }), null);
  assert.equal(pastedPath("jjkk", { exists }), null);
  assert.equal(pastedPath("~/a\\ b.png", { exists, home: "/home/me" }), "/home/me/a b.png");
});
