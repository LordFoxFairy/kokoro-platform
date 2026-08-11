import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { parse } from "yaml";

const root = resolve(import.meta.dirname, "../..");
const selector = "platform-core-single-site-prepare";

test("compiled runtime exposes prepare as a preflight selector, not a release deployable", async () => {
  const [entrypoint, manifest, packageDocument] = await Promise.all([
    readFile(resolve(root, "deploy/docker/runtime-entrypoint.mjs"), "utf8"),
    readFile(resolve(root, "deployables.yaml"), "utf8").then(parse),
    readFile(resolve(root, "package.json"), "utf8").then(JSON.parse),
  ]);

  assert.match(entrypoint, new RegExp(`"${selector}"`, "u"));
  assert.match(entrypoint, /module:\s*"\.\.\/\.\.\/dist\/src\/process\/core-single-site-prepare\.js"/u);
  assert.match(entrypoint, /start:\s*"runCoreSingleSitePrepareMain"/u);
  assert.equal(
    packageDocument.scripts["start:core-single-site-prepare"],
    "node --conditions=kokoro-runtime dist/src/process/core-single-site-prepare.js",
  );
  assert.equal(manifest.deployables.some((entry) =>
    entry.id === "platform-core-prepare" || entry.selectorEnvironment ===
      `KOKORO_SERVICE_PACKAGE=${selector}`), false);
});
