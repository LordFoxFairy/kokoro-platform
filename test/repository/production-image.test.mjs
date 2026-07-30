import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { parse } from "yaml";
import { verifyProductionImage } from "../../scripts/contract/verify-production-image.mjs";

const root = resolve(import.meta.dirname, "../..");
const workspaces = Object.freeze(["kokoro-platform-kit", "kokoro-hub"]);
const retired = Object.freeze([
  "kokoro-platform-admin", "kokoro-site", "kokoro-user", "kokoro-model",
  "kokoro-credit", "kokoro-payment",
]);
const required = Object.freeze([
  "deploy/docker/runtime-entrypoint.mjs",
  "dist/prisma.config.js",
  "dist/src/generated/platform-prisma/client.js",
  "dist/src/infrastructure/postgres/migrator.js",
  "dist/src/process/api.js",
  "dist/src/process/admission.js",
  "dist/src/process/admin.js",
  "dist/src/process/asset-data-plane.js",
  "dist/src/process/authorization.js",
  "dist/src/process/model-gateway.js",
  "dist/src/process/worker.js",
  "prisma/schema.prisma",
  "prisma/migrations/migration_lock.toml",
  "prisma/migrations/0001_platform_foundation/migration.sql",
  "node_modules/prisma/build/index.js",
  "kokoro-platform-kit/dist/index.js",
  "kokoro-hub/dist/interfaces/http/main.js",
]);

async function writeImageLayout(imageRoot) {
  for (const entry of required) {
    await mkdir(resolve(imageRoot, entry, ".."), { recursive: true });
    await writeFile(resolve(imageRoot, entry), "runtime\n");
  }
  await mkdir(resolve(imageRoot, "node_modules/.pnpm/fastify@5.10.0"), { recursive: true });
  await writeFile(resolve(imageRoot, "package.json"), JSON.stringify({
    dependencies: { "@kokoro/hub": "workspace:*", "@kokoro/platform-kit": "workspace:*" },
  }));
  for (const workspace of workspaces) {
    await mkdir(resolve(imageRoot, workspace, "node_modules"), { recursive: true });
    await writeFile(resolve(imageRoot, workspace, "package.json"), "{}\n");
  }
}

test("workspace, lock, and Dockerfile build only the fresh runtime", async () => {
  const [dockerfile, lockfile, workspace] = await Promise.all([
    readFile(resolve(root, "deploy/docker/Dockerfile"), "utf8"),
    readFile(resolve(root, "pnpm-lock.yaml"), "utf8").then(parse),
    readFile(resolve(root, "pnpm-workspace.yaml"), "utf8").then(parse),
  ]);
  assert.deepEqual(workspace.packages, workspaces);
  assert.equal(lockfile.settings?.autoInstallPeers, false);
  for (const active of workspaces) {
    assert.match(dockerfile, new RegExp(`COPY ${active}/package\\.json`, "u"));
    assert.match(dockerfile, new RegExp(`/app/${active}/dist`, "u"));
  }
  for (const legacy of retired) assert.doesNotMatch(dockerfile, new RegExp(legacy, "u"));
  assert.doesNotMatch(dockerfile, /DATABASE_URL_(?:SITE|USER|MODEL|CREDIT|PAYMENT|ADMIN)/u);
  assert.match(dockerfile, /ENV KOKORO_SERVICE_PACKAGE=platform-api/u);
});

test("runtime entrypoint exposes only PostgreSQL Platform processes and Hub", async () => {
  const entrypoint = await readFile(resolve(root, "deploy/docker/runtime-entrypoint.mjs"), "utf8");
  for (const role of [
    "platform-api", "platform-admission", "platform-admin", "platform-asset-data-plane",
    "platform-authorization", "platform-model-gateway", "platform-worker", "platform-migrator",
    "@kokoro/hub",
  ]) assert.match(entrypoint, new RegExp(`"${role}"`, "u"));
  for (const legacy of ["@kokoro/site", "@kokoro/user", "@kokoro/model", "@kokoro/credit",
    "@kokoro/payment"]) assert.doesNotMatch(entrypoint, new RegExp(legacy, "u"));
  assert.match(entrypoint, /\?\? "platform-api"/u);
});

test("production image verifier accepts the closed fresh layout", async (context) => {
  const imageRoot = await mkdtemp(resolve(tmpdir(), "kokoro-platform-image-"));
  context.after(() => rm(imageRoot, { recursive: true, force: true }));
  await writeImageLayout(imageRoot);
  await verifyProductionImage(imageRoot);
});

test("production image verifier rejects retired runtime packages", async (context) => {
  const imageRoot = await mkdtemp(resolve(tmpdir(), "kokoro-platform-image-retired-"));
  context.after(() => rm(imageRoot, { recursive: true, force: true }));
  await writeImageLayout(imageRoot);
  await mkdir(resolve(imageRoot, "kokoro-user/dist"), { recursive: true });
  await assert.rejects(() => verifyProductionImage(imageRoot), /unexpected image path|retired runtime/u);
});

test("production image verifier rejects dev tools and source artifacts", async (context) => {
  const imageRoot = await mkdtemp(resolve(tmpdir(), "kokoro-platform-image-dev-"));
  context.after(() => rm(imageRoot, { recursive: true, force: true }));
  await writeImageLayout(imageRoot);
  await mkdir(resolve(imageRoot, "node_modules/.bin"), { recursive: true });
  await writeFile(resolve(imageRoot, "node_modules/.bin/tsx"), "#!/bin/sh\n");
  await assert.rejects(() => verifyProductionImage(imageRoot), /development executable/u);
  await rm(resolve(imageRoot, "node_modules/.bin/tsx"));
  await writeFile(resolve(imageRoot, "dist/src/process/leak.ts"), "source\n");
  await assert.rejects(() => verifyProductionImage(imageRoot), /source artifact/u);
});
