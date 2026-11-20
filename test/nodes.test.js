import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { decodeFields } from "../src/tmux.js";

import {
  authSummary,
  normalizeNode,
  normalizeNodes,
  nodePassword,
  NodeError,
  parseProbe,
  parseSshConfig,
  removeNodeFromFile,
  renderNodeBlock,
  runOnNode,
  splitTarget,
  sshInvocation,
  upsertNodeInFile,
} from "../src/nodes.js";

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), "pp-nodes-"));
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test("a node only needs a name and a host", () => {
  const warnings = [];
  const node = normalizeNode({ name: "prod-01", host: "10.0.0.11" }, 0, "/tmp/x.yml", warnings);
  assert.equal(node.name, "prod-01");
  assert.equal(node.host, "10.0.0.11");
  assert.equal(node.port, 22, "default port");
  assert.equal(node.user, null, "no default user");
  assert.deepEqual(warnings, []);
});

test("user@host:port is split apart", () => {
  assert.deepEqual(splitTarget("deploy@10.0.0.11:2222"), { user: "deploy", host: "10.0.0.11", port: 2222 });
  assert.deepEqual(splitTarget("ssh://deploy@box:2222"), { user: "deploy", host: "box", port: 2222 });
  assert.deepEqual(splitTarget("box"), { user: null, host: "box", port: null });
  assert.deepEqual(splitTarget("box", "deploy", 2200), { user: "deploy", host: "box", port: 2200 });
});

test("bad names, ports and auth combinations are refused", () => {
  const bad = (spec, pattern) => {
    assert.throws(() => normalizeNode(spec, 0, "/tmp/x.yml", []), (err) => {
      assert.ok(err instanceof NodeError, `expected NodeError for ${JSON.stringify(spec)}`);
      assert.match(err.message, pattern);
      return true;
    });
  };
  bad({ host: "box" }, /name/);
  bad({ name: "prod 01", host: "box" }, /name/);
  bad({ name: "prod", host: "" }, /host/);
  bad({ name: "prod", host: "box", port: 0 }, /port/);
  bad({ name: "prod", host: "box", port: 70000 }, /port/);
  bad({ name: "prod", host: "box", password: "x", password_env: "PASS" }, /password_env/);
  bad({ name: "prod", host: "box", password_env: "1nope" }, /password_env/);
});

test("duplicate node names are refused, unknown keys are warned about", () => {
  const warnings = [];
  assert.throws(
    () => normalizeNodes([{ name: "a", host: "h1" }, { name: "a", host: "h2" }], { configPath: "/tmp/x.yml", warnings }),
    /duplicate node name "a"/,
  );
  const nodes = normalizeNodes([{ name: "a", host: "h1", sshpass: "x" }], { configPath: "/tmp/x.yml", warnings });
  assert.equal(nodes.length, 1);
  assert.match(warnings.join("\n"), /unknown key "sshpass"/);
});

test("ssh is invoked without a password in argv", () => {
  const node = normalizeNode({ name: "prod", host: "10.0.0.11", user: "deploy", port: 2222 }, 0, "/tmp/x.yml", []);
  const plain = sshInvocation(node, ["tmux", "ls"], { batch: true });
  assert.equal(plain.command, "ssh");
  assert.deepEqual(plain.argv, ["-p", "2222", "-o", "ConnectTimeout=10", "-o", "StrictHostKeyChecking=accept-new", "-o", "BatchMode=yes", "deploy@10.0.0.11", "tmux", "ls"]);
  assert.deepEqual(plain.env, {}, "no secret to pass");

  const withPass = normalizeNode({ ...node, password: "s3cret" }, 0, "/tmp/x.yml", []);
  const pass = sshInvocation(withPass, ["tmux", "ls"], {});
  assert.equal(pass.command, "sshpass");
  assert.equal(pass.argv[0], "-e", "password comes from SSHPASS, not argv");
  assert.equal(pass.argv.includes("s3cret"), false);
  assert.equal(pass.env.SSHPASS, "s3cret");
  assert.match(pass.argv.join(" "), /ssh .*deploy@10\.0\.0\.11 tmux ls/);
  assert.equal(sshInvocation(node, ["ls"], { batch: false }).argv.includes("BatchMode=yes"), false, "interactive ssh stays interactive");
});

test("a password can come from the environment instead", () => {
  const node = normalizeNode({ name: "prod", host: "box", password_env: "PP_PROD_PASS" }, 0, "/tmp/x.yml", []);
  assert.equal(nodePassword(node, {}), null);
  assert.equal(nodePassword(node, { PP_PROD_PASS: "hunter2" }), "hunter2");
  assert.throws(() => sshInvocation(node, ["tmux", "ls"], { env: {} }), /PP_PROD_PASS is not set/);
  assert.equal(authSummary(node, {}), "env:PP_PROD_PASS ✗");
  assert.equal(authSummary(node, { PP_PROD_PASS: "x" }), "env:PP_PROD_PASS ✓");
});

test("identity paths are expanded and flagged in the summary", () => {
  const node = normalizeNode({ name: "prod", host: "box", identity: "~/.ssh/id_ed25519" }, 0, "/tmp/x.yml", []);
  assert.equal(node.identity, join(process.env.HOME ?? "", ".ssh/id_ed25519"));
  assert.equal(authSummary(node, {}), "key:~/.ssh/id_ed25519");
  const inv = sshInvocation(node, ["true"], {});
  assert.deepEqual(inv.argv.slice(0, 2), ["-i", join(process.env.HOME ?? "", ".ssh/id_ed25519")]);
});

test("~/.ssh/config aliases become nodes", () => {
  const text = [
    "Host prod-01 textbook",
    "  HostName 10.0.0.11",
    "  User deploy",
    "  Port 2222",
    "  IdentityFile ~/.ssh/id_prod",
    "",
    "Host *",
    "  ServerAliveInterval 30",
  ].join("\n");
  const entries = parseSshConfig(text);
  assert.deepEqual(entries, [
    { name: "prod-01", host: "10.0.0.11", port: 2222, user: "deploy", identity: join(process.env.HOME ?? "", ".ssh/id_prod") },
    { name: "textbook", host: "10.0.0.11", port: 2222, user: "deploy", identity: join(process.env.HOME ?? "", ".ssh/id_prod") },
  ]);
});

test("the probe output is parsed into facts", () => {
  const probe = parseProbe("host=box\nos=Linux 6.8\narch=x86_64\ntmux=3.4\nnode=v22.11.0\npi=v0.7.0\npp=0.13.0\nup=3 days\nload=0.42 0.51 0.60\nsessions=4\n");
  assert.equal(probe.host, "box");
  assert.equal(probe.sessions, "4");
  assert.equal(probe.missing, undefined);
  assert.equal(parseProbe("host=box\n").tmux, undefined);
});

test("adding a node keeps the rest of the file byte for byte", () => {
  const box = sandbox();
  try {
    const path = join(box.dir, "plus.yml");
    const before = [
      "# my farm",
      "version: 1",
      "",
      "sessions:",
      "  - name: web",
      "    cwd: /srv/web",
      "",
      "tmux:",
      "  socket: pp",
      "",
    ].join("\n");
    writeFileSync(path, before);
    const node = normalizeNode({ name: "prod", host: "10.0.0.11", user: "deploy" }, 0, path, []);
    assert.equal(upsertNodeInFile(path, node), "added");
    const after = readFileSync(path, "utf8");
    assert.match(after, /^nodes:\n {2}- name: prod\n/m, "nodes section exists");
    assert.ok(after.indexOf("nodes:") < after.indexOf("sessions:"), "nodes come before sessions");
    // every original line survives, in order (nodes are inserted before sessions)
    let cursor = 0;
    for (const line of before.split("\n")) {
      const at = after.indexOf(line, cursor);
      assert.notEqual(at, -1, `line survived: ${JSON.stringify(line)}`);
      cursor = at;
    }

    // editing an existing node replaces it instead of appending a second copy
    const edited = normalizeNode({ name: "prod", host: "10.0.0.12" }, 0, path, []);
    assert.equal(upsertNodeInFile(path, edited), "updated");
    const text = readFileSync(path, "utf8");
    assert.equal(text.match(/- name: prod/g).length, 1);
    assert.match(text, /host: 10\.0\.0\.12/);
  } finally {
    box.done();
  }
});

test("removing a node leaves the sessions after it intact", () => {
  // regression: the section used to end at EOF, so removing the last node wiped
  // everything below `nodes:` — sessions included
  const box = sandbox();
  try {
    const path = join(box.dir, "plus.yml");
    writeFileSync(
      path,
      [
        "version: 1",
        "",
        "nodes:",
        "  - name: prod",
        "    host: 10.0.0.11",
        "",
        "sessions:",
        "  - name: web",
        "    cwd: /srv/web",
        "",
      ].join("\n"),
    );
    const node = normalizeNode({ name: "prod", host: "10.0.0.11" }, 0, path, []);
    assert.equal(removeNodeFromFile(path, node.name), true);
    const text = readFileSync(path, "utf8");
    assert.match(text, /^sessions:\n {2}- name: web$/m, "the sessions section survives");
    assert.equal(/- name: prod/.test(text), false);
    assert.equal(removeNodeFromFile(path, "prod"), false, "already gone");
  } finally {
    box.done();
  }
});

test("a password in the config tightens its permissions and is masked in the summary", () => {
  const box = sandbox();
  try {
    const path = join(box.dir, "plus.yml");
    writeFileSync(path, "version: 1\n");
    const node = normalizeNode({ name: "prod", host: "box", password: "s3cret" }, 0, path, []);
    upsertNodeInFile(path, node);
    const mode = statSync(path).mode & 0o777;
    assert.equal(mode, 0o600, "config holding a password is 0600");
    const text = readFileSync(path, "utf8");
    assert.match(text, /password: s3cret/);
    assert.equal(authSummary(node, {}), "password");
    assert.equal(renderNodeBlock(node).includes("password_env"), false);
  } finally {
    box.done();
  }
});

test("an unreachable node fails with something a human can act on", () => {
  const node = normalizeNode({ name: "gone", host: "192.0.2.1", port: 22 }, 0, "/tmp/x.yml", []);
  const env = { PATH: "/nonexistent-bin" }; // no ssh binary at all
  assert.throws(() => runOnNode(node, ["true"], { env, timeout: 1000 }), (err) => {
    assert.match(err.message, /ssh/);
    return true;
  });
});

test("a remote tmux that escapes the separator still parses", () => {
  // tmux 3.4 on a server turns the 0x1f byte in `-F` output into the four
  // characters \037, which used to make the whole line come back as one name
  // and every remote session look stopped.
  const line = "t114-check\\037%0\\037448207\\037bash\\0370\\037/tmp\\0371\\0370";
  const [name, , pid, command, dead, path] = decodeFields(line).split("\u001f");
  assert.equal(name, "t114-check");
  assert.equal(pid, "448207");
  assert.equal(command, "bash");
  assert.equal(dead, "0");
  assert.equal(path, "/tmp");
  // and a modern tmux that passes the byte through is unchanged
  const modern = ["web", "%1", "99", "pi", "0", "/srv", "2", "1"].join("\u001f");
  assert.equal(decodeFields(modern), modern);
});

test("tags are labels, not names: parsed, deduped, rendered", () => {
  const node = normalizeNode(
    { name: "p201", host: "10.0.0.1", tags: ["prod", "db", "prod"] },
    0,
    "<t>",
  );
  assert.deepEqual(node.tags, ["prod", "db"]);
  // a comma string is what people type in YAML by accident; accept it
  assert.deepEqual(normalizeNode({ name: "b", host: "h", tags: "dev, mysql" }, 0, "<t>").tags, ["dev", "mysql"]);
  // and a tag that would break the table is refused rather than printed
  assert.throws(() => normalizeNode({ name: "b", host: "h", tags: ["ok", "no spaces"] }, 0, "<t>"), /must start with a letter or digit/);
  // nothing declared means no tag key in the file, so a plain node stays plain
  assert.equal(normalizeNode({ name: "b", host: "h" }, 0, "<t>").tags.length, 0);
  assert.match(renderNodeBlock(node), /^ {4}tags: \[prod, db\]$/m);
  assert.doesNotMatch(renderNodeBlock(normalizeNode({ name: "b", host: "h" }, 0, "<t>")), /tags:/);
});

test("a guarded machine says so, and survives an edit", () => {
  const node = normalizeNode({ name: "p201", host: "h", guarded: true, tags: ["prod"] }, 0, "<t>");
  assert.equal(node.guarded, true);
  assert.match(renderNodeBlock(node), /^ {4}guarded: true$/m);
  // default is not guarded, and no key is written for it
  assert.equal(normalizeNode({ name: "b", host: "h" }, 0, "<t>").guarded, false);
  assert.doesNotMatch(renderNodeBlock(normalizeNode({ name: "b", host: "h" }, 0, "<t>")), /guarded/);
});

test("an empty nodes section is filled, not duplicated", () => {
  const file = join(tmpdir(), `pp-empty-nodes-${process.pid}.yml`);
  writeFileSync(file, "version: 1\nnodes: []\nsessions: []\n");
  upsertNodeInFile(file, normalizeNode({ name: "n1", host: "h" }, 0, file));
  const text = readFileSync(file, "utf8");
  assert.equal(text.match(/^nodes:/gm).length, 1);
  assert.match(text, /^ {2}- name: n1$/m);
  assert.match(text, /^sessions: \[\]$/m, "the sessions line is untouched");
  rmSync(file, { force: true });
});

test("a machine can carry its own base path and session defaults", () => {
  const node = normalizeNode(
    { name: "t114", host: "h", base_path: "/srv", defaults: { agent: "pi", restart: "no", remote_pi_mode: "env" } },
    0,
    "<t>",
  );
  assert.equal(node.basePath, "/srv");
  assert.deepEqual(node.defaults, { agent: "pi", restart: "no", remote_pi_mode: "env" });
  const text = renderNodeBlock(node);
  assert.match(text, /^ {4}base_path: \/srv$/m);
  assert.match(text, /^ {4}defaults:$/m);
  assert.match(text, /^ {6}restart: "no"$/m, "restart: no must be quoted or yaml reads a boolean");
});

test("base_path and defaults are validated", () => {
  assert.throws(() => normalizeNode({ name: "a", host: "h", base_path: "srv" }, 0, "<t>"), /base_path .* must be absolute/);
  assert.throws(() => normalizeNode({ name: "a", host: "h", defaults: ["x"] }, 0, "<t>"), /defaults must be a mapping/);
  assert.throws(() => normalizeNode({ name: "a", host: "h", defaults: { restart: "sometimes" } }, 0, "<t>"), /defaults\.restart/);
  const warnings = [];
  normalizeNode({ name: "a", host: "h", defaults: { cwd: "/x" } }, 0, "<t>", warnings);
  assert.equal(warnings.some((w) => w.includes("defaults.cwd")), true, "cwd is not a node-level default");
});
