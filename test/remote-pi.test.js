import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readRemotePiConfig,
  remotePiConfigExists,
  remotePiConfigPath,
  remotePiEnvConfig,
  writeRemotePiName,
} from "../src/remote-pi.js";

const dir = () => mkdtempSync(join(tmpdir(), "pp-remotepi-"));

test("the config path is the one remote-pi reads", () => {
  assert.equal(remotePiConfigPath("/srv/api"), "/srv/api/.pi/remote-pi/config.json");
});

test("a missing file is not an error", () => {
  const cwd = dir();
  assert.deepEqual(readRemotePiConfig(cwd), {});
  assert.equal(remotePiConfigExists(cwd), false);
});

test("a broken file is not an error either", () => {
  const cwd = dir();
  mkdirSync(join(cwd, ".pi/remote-pi"), { recursive: true });
  writeFileSync(join(cwd, ".pi/remote-pi/config.json"), "{not json");
  assert.deepEqual(readRemotePiConfig(cwd), {});
  writeFileSync(join(cwd, ".pi/remote-pi/config.json"), "[1,2,3]");
  assert.deepEqual(readRemotePiConfig(cwd), {}, "an array is not a config");
});

test("writing the name keeps every other key, and creates the directory", () => {
  const cwd = join(dir(), "nested", "cwd");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(join(cwd, ".pi/remote-pi"), { recursive: true });
  writeFileSync(join(cwd, ".pi/remote-pi/config.json"), JSON.stringify({ agent_name: "old", peer_timeout_ms: 5000 }));
  const path = writeRemotePiName(cwd, "api");
  const saved = JSON.parse(readFileSync(path, "utf8"));
  assert.deepEqual(saved, { agent_name: "api", peer_timeout_ms: 5000 });
  assert.equal(remotePiConfigExists(cwd), true);
});

test("env mode merges the file instead of replacing it", () => {
  const cwd = dir();
  mkdirSync(join(cwd, ".pi/remote-pi"), { recursive: true });
  writeFileSync(join(cwd, ".pi/remote-pi/config.json"), JSON.stringify({ agent_name: "stale", mode: "direct" }));
  assert.deepEqual(remotePiEnvConfig(cwd, "fresh"), { agent_name: "fresh", mode: "direct" });
});
