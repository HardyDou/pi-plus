import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import test from "node:test";

const ROOT = new URL("..", import.meta.url).pathname;

/** Every markdown file a reader can reach: the README and everything in docs/. */
function markdownFiles() {
  return ["README.md", ...readdirSync(join(ROOT, "docs")).filter((name) => name.endsWith(".md")).map((name) => join("docs", name))];
}

function localLinks(file) {
  const text = readFileSync(join(ROOT, file), "utf8");
  const links = [];
  for (const match of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const target = match[1].split("#")[0].trim();
    if (!target || /^(https?:|mailto:)/.test(target)) continue;
    links.push(target);
  }
  return links;
}

test("every relative link in the docs points at a file that exists", () => {
  const broken = [];
  for (const file of markdownFiles()) {
    for (const link of localLinks(file)) {
      const target = normalize(join(dirname(join(ROOT, file)), link));
      if (!existsSync(target)) broken.push(`${file} -> ${link}`);
    }
  }
  assert.deepEqual(broken, [], `broken links:\n${broken.join("\n")}`);
});

test("the docs a reader is sent to are reachable from the README index", () => {
  const readme = readFileSync(join(ROOT, "README.md"), "utf8");
  const index = readme.slice(readme.indexOf("## 文档"), readme.indexOf("## 配置参考"));
  const missing = readdirSync(join(ROOT, "docs"))
    .filter((name) => name.endsWith(".md"))
    .filter((name) => name !== "runbook.md")
    .filter((name) => !index.includes(`docs/${name}`))
    .filter((name) => !index.includes(`(${name})`));
  assert.deepEqual(missing, [], `docs not listed in the README index: ${missing.join(", ")}`);
});
