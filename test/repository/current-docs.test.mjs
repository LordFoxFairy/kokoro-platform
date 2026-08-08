import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "../..");
const platformDocs = Object.freeze([
  "docs/platform/deployment-topology.md",
  "docs/platform/media-worker-launch-blockers.md",
  "docs/platform/modules/README.md",
  "docs/platform/multi-site/README.md",
]);
const currentAuthorities = Object.freeze([
  "README.md",
  "INDEX.md",
  "docs/README.md",
  "kokoro-hub/README.md",
  "kokoro-hub/INDEX.md",
  ...platformDocs,
]);
const retiredCurrentFact =
  /kokoro-(?:site|user|model|credit|payment|platform-admin)\b|\bmysql\b|admin gateway|admin \u7f51\u5173|http:\/\/kokoro-/iu;

async function markdownFiles(directory) {
  const entries = await readdir(resolve(root, directory), { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const relative = `${directory}/${entry.name}`;
    if (entry.isDirectory()) return markdownFiles(relative);
    return entry.isFile() && entry.name.endsWith(".md") ? [relative] : [];
  }));
  return nested.flat().sort();
}

test("Platform current docs are a closed authority set", async () => {
  assert.deepEqual(await markdownFiles("docs/platform"), [...platformDocs]);
});

test("current authorities do not preserve retired service or database topology", async () => {
  for (const path of currentAuthorities) {
    const source = await readFile(resolve(root, path), "utf8");
    assert.doesNotMatch(source, retiredCurrentFact, path);
  }
});
