import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "../..");

test("platform CI is lock-driven and separates local from integration gates", async () => {
  const workflow = await readFile(resolve(root, ".github/workflows/ci.yml"), "utf8");
  const packageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));

  assert.equal(packageJson.packageManager, "pnpm@11.2.2");
  assert.match(workflow, /node-version:\s*["']?22["']?/u);
  assert.match(workflow, /corepack enable/u);
  assert.match(workflow, /pnpm install --frozen-lockfile/u);
  assert.match(workflow, /pnpm lint/u);
  assert.match(workflow, /pnpm typecheck/u);
  assert.match(workflow, /pnpm test/u);
  assert.match(workflow, /^\s{2}integration:/mu);
  assert.match(workflow, /pnpm test:integration/u);
  assert.match(workflow, /mysql:/u);
  assert.match(workflow, /mongo:/u);
  assert.match(workflow, /redis:/u);
  assert.match(workflow, /minio:/u);
});

test("the root test gate executes repository governance checks", async () => {
  const packageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));

  assert.equal(packageJson.scripts["test:repository"], "node --test test/repository/*.test.mjs");
  assert.match(packageJson.scripts.test, /pnpm run test:repository/u);
});

test("platform CI builds the repository-owned deployment artifact", async () => {
  const workflow = await readFile(resolve(root, ".github/workflows/ci.yml"), "utf8");

  assert.match(workflow, /^\s{2}artifact:/mu);
  assert.match(workflow, /needs:\s*\[gates, integration\]/u);
  assert.match(workflow, /docker build/u);
  assert.match(workflow, /--file deploy\/docker\/Dockerfile/u);
  assert.match(workflow, /--tag kokoro-platform:\$\{\{ github\.sha \}\}/u);
});
