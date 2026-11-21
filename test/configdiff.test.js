import assert from "node:assert/strict";
import test from "node:test";

import { configChanges } from "../src/configdiff.js";

const base = `version: 1
sessions:
  - name: api
    cwd: /srv/api
    restart: "no"
nodes:
  - name: p201
    host: deploy@10.0.0.1
    guarded: true
`;

test("a new session and a removed node are both reported", () => {
  const after = base
    .replace('  - name: p201\n    host: deploy@10.0.0.1\n    guarded: true\n', "")
    .replace('    restart: "no"\n', '    restart: "no"\n  - name: web\n    cwd: /srv/web\n');
  const { total, lines } = configChanges(base, after);
  assert.equal(total, 2);
  assert.ok(lines.includes("+sessions.web"), lines.join(" | "));
  assert.ok(lines.includes("-nodes.p201"), lines.join(" | "));
});

test("field edits name the field, the old value and the new one", () => {
  const after = base.replace("cwd: /srv/api", "cwd: /srv/api-v2").replace("guarded: true", "guarded: false");
  const { total, lines } = configChanges(base, after);
  assert.equal(total, 2);
  assert.deepEqual(lines, ["sessions.api cwd: /srv/api -> /srv/api-v2", "nodes.p201 guarded: true -> false"]);
});

test("a dropped field is a change too, and identical files are quiet", () => {
  const after = base.replace("    guarded: true\n", "");
  const dropped = configChanges(base, after);
  assert.equal(dropped.total, 1);
  assert.match(dropped.lines[0], /nodes\.p201 guarded: true -> \(removed\)/);
  assert.deepEqual(configChanges(base, base), { total: 0, lines: [] });
});

test("the list is capped but the count is not", () => {
  const after = base + ["  - name: a", "    cwd: /a", "  - name: b", "    cwd: /b", "  - name: c", "    cwd: /c"].join("\n") + "\n";
  const { total, lines } = configChanges(base, after, { limit: 2 });
  assert.equal(total, 3);
  assert.equal(lines.length, 2);
});
