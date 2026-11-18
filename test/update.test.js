import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  compareVersions,
  fetchLatestVersion,
  installKind,
  planUpdate,
  UpdateError,
} from "../src/update.js";

test("compareVersions is numeric, ignores pre-release tags", () => {
  assert.equal(compareVersions("0.3.0", "0.3.0"), 0);
  assert.equal(compareVersions("0.10.0", "0.9.9"), 1);
  assert.equal(compareVersions("0.9.9", "0.10.0"), -1);
  assert.equal(compareVersions("1.0.0", "1.0.0-beta.2"), 0);
  assert.equal(compareVersions("1.0", "1.0.1"), -1);
  assert.equal(compareVersions("2", "1.99.99"), 1);
});

function fakeInstall(kind) {
  const dir = mkdtempSync(join(tmpdir(), "pp-update-"));
  const binDir = kind === "npm" ? join(dir, "lib", "node_modules", "pi-farm", "bin") : join(dir, "bin");
  mkdirSync(binDir, { recursive: true });
  const script = join(binDir, "pp.js");
  writeFileSync(script, "#!/usr/bin/env node\n");
  if (kind === "git") {
    mkdirSync(join(dir, ".git"));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "pi-farm", version: "0.3.0" }));
  } else if (kind === "npm") {
    writeFileSync(join(dir, "lib", "node_modules", "pi-farm", "package.json"), JSON.stringify({ name: "pi-farm" }));
  }
  return { dir, script };
}

test("installKind finds npm, git and unknown copies", () => {
  const npm = fakeInstall("npm");
  assert.equal(installKind(npm.script).kind, "npm");

  const git = fakeInstall("git");
  const info = installKind(git.script);
  assert.equal(info.kind, "git");
  // macOS: tmpdir() is /var/folders/... which is really /private/var/folders/...
  assert.equal(realpathSync(info.root), realpathSync(git.dir));

  const loose = mkdtempSync(join(tmpdir(), "pp-loose-"));
  writeFileSync(join(loose, "pp.js"), "");
  assert.equal(installKind(join(loose, "pp.js")).kind, "unknown");
});

test("planUpdate uses npm for npm installs and git pull for checkouts", () => {
  const npm = planUpdate({ kind: "npm", currentVersion: "0.3.0", latestVersion: "0.4.0", path: "/usr/lib/node_modules/pi-farm/bin/pp.js" });
  assert.equal(npm.command, "npm");
  assert.deepEqual(npm.args, ["i", "-g", "pi-farm@0.4.0", "--registry", "https://registry.npmjs.org"]);

  const brew = planUpdate({ kind: "npm", latestVersion: "0.4.0", path: "/opt/homebrew/Cellar/pi-farm/0.3.0/bin/pp.js" });
  assert.match(brew.note, /Homebrew/);

  const git = planUpdate({ kind: "git", latestVersion: "0.4.0", root: "/srv/pi-plus" });
  assert.equal(git.command, "git");
  assert.deepEqual(git.args, ["-C", "/srv/pi-plus", "pull", "--ff-only"]);

  assert.equal(planUpdate({ kind: "unknown", latestVersion: "0.4.0" }), null);
});

async function withRegistry(handler, fn) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("fetchLatestVersion reads the version from the registry", async () => {
  await withRegistry(
    (request, response) => {
      assert.equal(request.url, "/pi-farm/latest");
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ name: "pi-farm", version: "9.9.9" }));
    },
    async (registry) => {
      assert.equal(await fetchLatestVersion({ registry }), "9.9.9");
    },
  );
});

test("fetchLatestVersion reports HTTP errors and bad payloads", async () => {
  await withRegistry(
    (request, response) => {
      response.statusCode = request.url === "/pi-farm/latest" ? 404 : 500;
      response.end("{}");
    },
    async (registry) => {
      await assert.rejects(() => fetchLatestVersion({ registry }), (error) => {
        assert.equal(error instanceof UpdateError, true);
        assert.match(error.message, /HTTP 404/);
        return true;
      });
    },
  );

  await withRegistry(
    (request, response) => {
      response.end(JSON.stringify({ name: "pi-farm" }));
    },
    async (registry) => {
      await assert.rejects(() => fetchLatestVersion({ registry }), /no version field/);
    },
  );
});

test("fetchLatestVersion times out instead of hanging", async () => {
  await withRegistry(
    () => {
      /* never answer */
    },
    async (registry) => {
      await assert.rejects(() => fetchLatestVersion({ registry, timeoutMs: 150 }), (error) => {
        assert.equal(error.code, "offline");
        assert.match(error.message, /timeout/);
        return true;
      });
    },
  );
});
