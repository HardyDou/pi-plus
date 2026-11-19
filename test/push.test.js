import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  assertReadableFile,
  attachedSessionArgs,
  controlPathPath,
  dropName,
  parseActiveSsh,
  parseAttachedSession,
  parsePushTarget,
  PushError,
  remoteDropsDir,
  resolvePushTarget,
  sshBaseArgs,
  tmuxPrefillArgs,
} from "../src/push.js";

test("parsePushTarget understands host, user, port and session", () => {
  assert.deepEqual(
    { ...parsePushTarget("mybox"), session: null, port: null, user: null },
    { raw: "mybox", user: null, host: "mybox", port: null, session: null, target: "mybox" },
  );
  assert.equal(parsePushTarget("hardy@1.2.3.4").target, "hardy@1.2.3.4");
  assert.equal(parsePushTarget("hardy@1.2.3.4:2222").port, 2222);
  assert.equal(parsePushTarget("hardy@1.2.3.4:delta").session, "delta");
  const full = parsePushTarget("hardy@1.2.3.4:2222#risk-01");
  assert.deepEqual(
    { target: full.target, port: full.port, session: full.session },
    { target: "hardy@1.2.3.4", port: 2222, session: "risk-01" },
  );
});

test("parsePushTarget rejects nonsense instead of guessing", () => {
  assert.throws(() => parsePushTarget(""), PushError);
  assert.throws(() => parsePushTarget("@host"), /empty user/);
  assert.throws(() => parsePushTarget("host:"), /ends with ":"/);
  assert.throws(() => parsePushTarget("host:bad:name"), /too many ":"/);
  assert.throws(() => parsePushTarget("host:delta:x"), /too many ":"/);
});

test("sshBaseArgs and controlPathPath keep every call on one master", () => {
  assert.deepEqual(sshBaseArgs("h", { controlPath: "/tmp/cm", port: 2222 }), [
    "-p",
    "2222",
    "-o",
    "ControlPath=/tmp/cm",
  ]);
  assert.equal(controlPathPath("~/.ssh/cm-pp-%r@%h-%p", "/home/u"), "/home/u/.ssh/cm-pp-%r@%h-%p");
});

test("parseActiveSsh picks the newest real login and ignores plumbing", () => {
  const ps = [
    "  100 ssh -M -N -f -o ControlPath=/tmp/cm hardy@1.2.3.4",
    "  200 ssh hardy@1.2.3.4",
    "  150 ssh -O check hardy@1.2.3.4",
    "  300 ssh -p 2222 hardy@5.6.7.8:delta",
    "  400 /usr/bin/ssh-copy-id hardy@9.9.9.9",
    "  500 ssh-keygen -t ed25519",
    "  600 vim notes.txt",
  ].join("\n");
  const found = parseActiveSsh(ps);
  assert.equal(found.pid, 300);
  assert.equal(found.target, "hardy@5.6.7.8");
  assert.equal(found.port, 2222);
  assert.equal(found.session, "delta");
  assert.equal(parseActiveSsh("  1 bash\n"), null);
});

test("resolvePushTarget follows the documented precedence", () => {
  const detected = { raw: "hardy@10.0.0.2:delta" };
  assert.equal(resolvePushTarget({ spec: "a@1.1.1.1", env: { PP_PUSH_TARGET: "b@2.2.2.2" } }).target, "a@1.1.1.1");
  assert.equal(resolvePushTarget({ env: { PP_PUSH_TARGET: "b@2.2.2.2" }, detected }).target, "b@2.2.2.2");
  const fromConfig = resolvePushTarget({ env: {}, configPush: { target: "c@3.3.3.3", session: "ops" }, detected });
  assert.equal(fromConfig.target, "c@3.3.3.3");
  assert.equal(fromConfig.session, "ops");
  assert.equal(fromConfig.source, "config");
  const guessed = resolvePushTarget({ env: {}, detected, host: "laptop" });
  assert.equal(guessed.host, "10.0.0.2");
  assert.equal(guessed.source, "detected");
  const fallback = resolvePushTarget({ env: {}, detected: null, host: "laptop" });
  assert.equal(fallback.target, "laptop");
  assert.equal(fallback.source, "hostname");
});

test("remote paths and tmux args are built the way tmux expects", () => {
  assert.equal(remoteDropsDir({ session: "delta" }), join("~/.pi/plus/drops", "delta"));
  assert.equal(remoteDropsDir({}), join("~/.pi/plus/drops", "inbox"));
  assert.equal(remoteDropsDir({ dir: "/tmp/drops" }), "/tmp/drops");
  assert.deepEqual(tmuxPrefillArgs({ session: "delta", path: "/a/b.png" }), [
    "send-keys",
    "-t",
    "=delta:",
    "-l",
    "--",
    "/a/b.png",
  ]);
  assert.deepEqual(tmuxPrefillArgs({ session: "delta", path: "/a/b.png", socket: "ppx" }), [
    "-L",
    "ppx",
    "send-keys",
    "-t",
    "=delta:",
    "-l",
    "--",
    "/a/b.png",
  ]);
  assert.deepEqual(attachedSessionArgs({ socket: "ppx" }), [
    "-L",
    "ppx",
    "list-clients",
    "-F",
    "#{client_activity} #{client_session}",
  ]);
  assert.equal(parseAttachedSession("1795091366 delta\n1795091500 api\n"), "api");
  assert.equal(parseAttachedSession(""), null);
});

test("dropName is timestamped and filesystem safe", () => {
  const name = dropName("/tmp/My Screen Shot?.PNG", new Date(2026, 10, 19, 20, 50, 3));
  assert.match(name, /^2026-11-19_205003-[A-Za-z0-9._-]+\.PNG$/);
  assert.ok(!/[\s?]/.test(name));
});

test("assertReadableFile resolves paths and rejects the wrong ones", () => {
  const dir = mkdtempSync(join(tmpdir(), "pp-push-"));
  const file = join(dir, "a.png");
  writeFileSync(file, "x");
  assert.equal(assertReadableFile(file), file);
  assert.throws(() => assertReadableFile(join(dir, "missing.png")), /no such file/);
  assert.throws(() => assertReadableFile(dir), /not a regular file/);
});
