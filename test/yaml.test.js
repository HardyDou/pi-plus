import assert from "node:assert/strict";
import test from "node:test";
import { parseYaml, YamlError } from "../src/yaml.js";

test("parses nested mappings, sequences and comments", () => {
  const cfg = parseYaml(`
# top comment
version: 1
sessions:
  - name: backend      # trailing comment
    cwd: /tmp/backend
    env:
      FOO: bar
      "QUOTED KEY": 'it''s here'
  - name: docs
    cwd: "/tmp/docs"
`);
  assert.equal(cfg.version, 1);
  assert.equal(cfg.sessions.length, 2);
  assert.equal(cfg.sessions[0].name, "backend");
  assert.deepEqual(cfg.sessions[0].env, { FOO: "bar", "QUOTED KEY": "it's here" });
  assert.equal(cfg.sessions[1].cwd, "/tmp/docs");
});

test("parses flow collections and scalar types", () => {
  const cfg = parseYaml(`
list: [a, "b, c", 3, true, null]
map: {k: v, n: 2}
json: {"x": [1, 2]}
negative: -3
float: 1.5
stringy: 1a2b
`);
  assert.deepEqual(cfg.list, ["a", "b, c", 3, true, null]);
  assert.deepEqual(cfg.map, { k: "v", n: 2 });
  assert.deepEqual(cfg.json, { x: [1, 2] });
  assert.equal(cfg.negative, -3);
  assert.equal(cfg.float, 1.5);
  assert.equal(cfg.stringy, "1a2b");
});

test("keeps hashes inside quoted scalars", () => {
  const cfg = parseYaml(`name: "a # b"\nother: c#d\n`);
  assert.equal(cfg.name, "a # b");
  assert.equal(cfg.other, "c#d");
});

test("parses literal and folded block scalars", () => {
  const cfg = parseYaml(`
literal: |
  line one
  line two
folded: >
  hello
  world
stripped: |-
  no trailing newline
`);
  assert.equal(cfg.literal, "line one\nline two\n");
  assert.equal(cfg.folded, "hello world\n");
  assert.equal(cfg.stripped, "no trailing newline");
});

test("parses sequences of scalars and nested sequences", () => {
  const cfg = parseYaml(`
args:
  - --approve
  - --model
  - sonnet
nested:
  -
    - a
    - b
`);
  assert.deepEqual(cfg.args, ["--approve", "--model", "sonnet"]);
  assert.deepEqual(cfg.nested, [["a", "b"]]);
});

test("returns null for empty input", () => {
  assert.equal(parseYaml(""), null);
  assert.equal(parseYaml("# only a comment\n"), null);
});

test("rejects tab indentation with a line number", () => {
  assert.throws(() => parseYaml("a:\n\tb: 1\n"), (err) => {
    assert.ok(err instanceof YamlError);
    assert.match(err.message, /tab/);
    assert.equal(err.line, 2);
    return true;
  });
});
