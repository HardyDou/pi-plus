import assert from "node:assert/strict";
import { test } from "node:test";

import {
  formatSessionLabel,
  formatStatusLines,
  matchSessionName,
  parsePeekArgs,
  parseTmuxEnv,
  pickClient,
  sessionNameFromLabel,
  shortPath,
  trimCapture,
} from "../src/ppui.js";

test("parseTmuxEnv splits socket, pid and index", () => {
  assert.deepEqual(parseTmuxEnv("/tmp/tmux-1000/default,4242,3"), {
    socketPath: "/tmp/tmux-1000/default",
    serverPid: 4242,
    sessionIndex: 3,
  });
  // socket paths may contain commas (rare, but tmux splits from the right)
  assert.equal(parseTmuxEnv("/tmp/od,d/sock,12,0").socketPath, "/tmp/od,d/sock");
  assert.equal(parseTmuxEnv(""), null);
  assert.equal(parseTmuxEnv(undefined), null);
  assert.equal(parseTmuxEnv("nonsense"), null);
});

test("shortPath keeps the last two segments", () => {
  assert.equal(shortPath("/data/Mango/mango"), "/data/Mango/mango");
  assert.equal(shortPath("/data/Yunxin/mango-baohan/mango-baohan-risk"), "…/mango-baohan/mango-baohan-risk");
  assert.equal(shortPath("", 10), "");
  assert.equal(shortPath("/very/long/path/that/keeps/going/and/going", 20).startsWith("…"), true);
});

test("formatSessionLabel marks the current and dead sessions", () => {
  const current = formatSessionLabel({ name: "backend", path: "/data/work/x", windows: 2, current: true });
  assert.match(current, /^\* backend/);
  assert.match(current, /2w/);
  assert.match(current, /\(current\)/);

  const dead = formatSessionLabel({ name: "ops", path: "/srv/ops", windows: 1, dead: true });
  assert.match(dead, /^ {2}ops/);
  assert.match(dead, /\(dead\)/);

  const many = formatSessionLabel({ name: "risk", windows: 1, attached: 3 });
  assert.match(many, /\(3 clients\)/);
});

test("sessionNameFromLabel recovers the tmux session name", () => {
  assert.equal(sessionNameFromLabel("* backend   /data/work/x  2w  (current)"), "backend");
  assert.equal(sessionNameFromLabel("  ops-5   /data/Yunxin/yunwei  1w"), "ops-5");
  assert.equal(sessionNameFromLabel(""), "");
});

test("matchSessionName resolves exact, case-insensitive and unique prefixes", () => {
  const names = ["backend", "backlog", "ops-5", "risk-01"];
  assert.deepEqual(matchSessionName(names, "backend"), { name: "backend" });
  assert.deepEqual(matchSessionName(names, "OPS-5"), { name: "ops-5" });
  assert.deepEqual(matchSessionName(names, "risk"), { name: "risk-01" });
  assert.match(matchSessionName(names, "back").error, /ambiguous: backend, backlog/);
  assert.match(matchSessionName(names, "nope").error, /no tmux session named "nope"/);
  assert.match(matchSessionName(names, "").error, /no session name given/);
});

test("parsePeekArgs handles session name, -n, -nN and bare -N", () => {
  assert.deepEqual(parsePeekArgs(""), { target: null, lines: 30 });
  assert.deepEqual(parsePeekArgs("backend"), { target: "backend", lines: 30 });
  assert.deepEqual(parsePeekArgs("backend -n 10"), { target: "backend", lines: 10 });
  assert.deepEqual(parsePeekArgs("-n 5 ops-5"), { target: "ops-5", lines: 5 });
  assert.deepEqual(parsePeekArgs("backend -n20"), { target: "backend", lines: 20 });
  assert.deepEqual(parsePeekArgs("backend -20"), { target: "backend", lines: 20 });
  assert.match(parsePeekArgs("backend -n").error, /-n needs a number/);
  assert.match(parsePeekArgs("backend -n abc").error, /needs a number, got "abc"/);
  assert.match(parsePeekArgs("a b").error, /unexpected argument "b"/);
  assert.match(parsePeekArgs("backend --bogus").error, /unknown option --bogus/);
  assert.match(parsePeekArgs("backend -n 900").error, /between 1 and 500/);
});

test("trimCapture drops trailing blank lines and keeps the tail", () => {
  assert.equal(trimCapture("a\nb\n\n\n", 5), "a\nb");
  assert.equal(trimCapture("1\n2\n3\n4\n5", 2), "4\n5");
  assert.equal(trimCapture("", 3), "");
  assert.equal(trimCapture("x\r\ny\r\n", 5), "x\ny");
});

test("pickClient prefers the most recently active client of the session", () => {
  const clients = [
    { name: "/dev/pts/1", session: "a", activity: 100 },
    { name: "/dev/pts/2", session: "a", activity: 300 },
    { name: "/dev/pts/3", session: "b", activity: 900 },
  ];
  assert.equal(pickClient(clients, "a"), "/dev/pts/2");
  assert.equal(pickClient(clients, "zzz"), null);
});

test("formatStatusLines aligns labels and drops empty values", () => {
  const lines = formatStatusLines({
    session: "backend",
    pane: "%3",
    cwd: "/data/work/x",
    piSessionName: "",
    remotePi: "backend  (/data/work/x@backend, relay on)",
  });
  assert.equal(lines.length, 4);
  assert.match(lines[0], /^session\s+backend$/);
  assert.equal(lines.every((line) => !line.includes("undefined")), true);
  // labels are padded to the widest label ("remote-pi") plus two spaces
  assert.deepEqual(lines, [
    "session    backend",
    "pane       %3",
    "cwd        /data/work/x",
    "remote-pi  backend  (/data/work/x@backend, relay on)",
  ]);
});
