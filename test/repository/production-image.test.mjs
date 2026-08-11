import assert from "node:assert/strict";
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { parse } from "yaml";
import { verifyProductionImage } from "../../scripts/contract/verify-production-image.mjs";

const root = resolve(import.meta.dirname, "../..");
const repositoryRequire = createRequire(import.meta.url);
const argon2Entry = repositoryRequire.resolve("@node-rs/argon2");
const argon2Require = createRequire(argon2Entry);
const argon2Manifest = repositoryRequire("@node-rs/argon2/package.json");
const argon2NativePackage = Object.keys(argon2Manifest.optionalDependencies).find((name) => {
  try {
    argon2Require.resolve(name);
    return true;
  } catch {
    return false;
  }
});
assert.ok(argon2NativePackage, "the test host must install the current Argon2 native package");
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
  "dist/src/process/platform-api-runtime-contract.js",
  "dist/src/process/platform-public-composition.js",
  "dist/src/process/secret-files.js",
  "dist/src/process/admission.js",
  "dist/src/process/admin.js",
  "dist/src/process/admin-authority-bootstrap.js",
  "dist/src/process/asset-data-plane.js",
  "dist/src/process/artifact-data-plane.js",
  "dist/src/process/artifact-data-plane-composition.js",
  "dist/src/process/authorization.js",
  "dist/src/process/model-gateway.js",
  "dist/src/process/model-image-worker.js",
  "dist/src/process/model-image-worker-composition.js",
  "dist/src/process/core-single-site-bootstrap.js",
  "dist/src/process/core-single-site-prepare.js",
  "dist/src/process/worker.js",
  "dist/src/process/identity-worker.js",
  "dist/src/process/media-worker.js",
  "dist/src/process/worker-health-server.js",
  "dist/src/process/worker-deployment-contract.js",
  "prisma/schema.prisma",
  "prisma/migrations/migration_lock.toml",
  "prisma/migrations/0001_platform_foundation/migration.sql",
  "node_modules/prisma/build/index.js",
  "kokoro-platform-kit/dist/index.js",
  "kokoro-hub/dist/interfaces/http/main.js",
  "dist/src/process/hub-connect.js",
]);

async function writeImageLayout(imageRoot) {
  for (const entry of required) {
    await mkdir(resolve(imageRoot, entry, ".."), { recursive: true });
    await writeFile(resolve(imageRoot, entry), "runtime\n");
  }
  await mkdir(resolve(imageRoot, "node_modules/.pnpm/fastify@5.10.0"), { recursive: true });
  for (const [name, entry] of [
    ["@node-rs/argon2", argon2Entry],
    [argon2NativePackage, argon2Require.resolve(argon2NativePackage)],
  ]) {
    const target = resolve(imageRoot, "node_modules", name);
    await mkdir(dirname(target), { recursive: true });
    await cp(dirname(entry), target, { recursive: true, dereference: true });
  }
  await writeFile(resolve(imageRoot, "package.json"), JSON.stringify({
    dependencies: {
      "@kokoro/hub": "workspace:*",
      "@kokoro/platform-kit": "workspace:*",
      "@node-rs/argon2": "2.0.2",
    },
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
  assert.doesNotMatch(dockerfile, /pnpm install --prod --no-optional/u);
  assert.match(
    dockerfile,
    /pnpm install --prod --config\.auto-install-peers=false --frozen-lockfile --ignore-scripts/u,
  );
  assert.match(
    dockerfile,
    /rm -rf node_modules\/typescript node_modules\/\.pnpm\/typescript@\*/u,
  );
  assert.match(dockerfile, /rm -f node_modules\/\.bin\/tsc/u);
  assert.match(
    dockerfile,
    /find node_modules -type l \\\( -name typescript -o -name tsc \\\) -delete/u,
  );
  assert.match(
    dockerfile,
    /find node_modules -path '\*\/\.bin\/tsc' -delete/u,
  );
  assert.match(dockerfile, /ENV KOKORO_SERVICE_PACKAGE=platform-api/u);
});

test("runtime entrypoint exposes only PostgreSQL Platform processes and Hub", async () => {
  const entrypoint = await readFile(resolve(root, "deploy/docker/runtime-entrypoint.mjs"), "utf8");
  for (const role of [
    "platform-api", "platform-admission", "platform-admin", "platform-asset-data-plane",
    "platform-artifact-data-plane",
    "platform-authorization", "platform-model-gateway", "platform-commerce-worker",
    "platform-site-worker", "platform-asset-worker", "platform-admin-worker",
    "platform-identity-worker", "platform-media-worker", "platform-model-image-worker",
    "platform-authorization-maintenance", "platform-migrator",
    "@kokoro/hub",
    "platform-hub-connect",
  ]) assert.match(entrypoint, new RegExp(`"${role}"`, "u"));
  for (const legacy of ["@kokoro/site", "@kokoro/user", "@kokoro/model", "@kokoro/credit",
    "@kokoro/payment"]) assert.doesNotMatch(entrypoint, new RegExp(legacy, "u"));
  assert.match(entrypoint, /\?\? "platform-api"/u);
});

test("production image carries the sealed one-time Admin authority bootstrap", async () => {
  const [dockerfile, runtime] = await Promise.all([
    readFile(resolve(root, "deploy/docker/Dockerfile"), "utf8"),
    readFile(resolve(root, "src/process/admin-authority-bootstrap.ts"), "utf8"),
  ]);
  assert.match(dockerfile, /pnpm build:runtime/u);
  assert.match(runtime, /bootstrap_admin_authorities/u);
  assert.match(runtime, /O_NOFOLLOW/u);
  assert.match(runtime, /loadPlatformDatabaseConfig\("migrator", environment\)/u);
});

test("worker deployment safely resolves Kubernetes AtomicWriter identity secrets", async () => {
  const [reader, kubernetes] = await Promise.all([
    readFile(resolve(root, "src/process/secret-files.ts"), "utf8"),
    readFile(resolve(root, "deploy/k8s/platform-services.example.yaml"), "utf8"),
  ]);
  assert.match(reader, /createBoundedFileReaderWithinTrustRoot/u);
  assert.match(reader, /realpath/u);
  assert.match(reader, /O_NOFOLLOW/u);
  assert.match(kubernetes, /fieldPath: metadata\.uid/u);
  assert.match(kubernetes, /runAsNonRoot: true/u);
  assert.match(kubernetes, /fsGroup: 1000/u);
  assert.match(kubernetes, /defaultMode: 0440/u);
});

test("production image verifier accepts the closed fresh layout", async (context) => {
  const imageRoot = await mkdtemp(resolve(tmpdir(), "kokoro-platform-image-"));
  context.after(() => rm(imageRoot, { recursive: true, force: true }));
  await writeImageLayout(imageRoot);
  await verifyProductionImage(imageRoot);
});

test("production image verifier rejects an unloadable Argon2 native runtime", async (context) => {
  const imageRoot = await mkdtemp(resolve(tmpdir(), "kokoro-platform-image-argon2-"));
  context.after(() => rm(imageRoot, { recursive: true, force: true }));
  await writeImageLayout(imageRoot);
  const imageRequire = createRequire(resolve(imageRoot, "package.json"));
  await rm(imageRequire.resolve(argon2NativePackage));
  await assert.rejects(
    () => verifyProductionImage(imageRoot),
    /cannot load @node-rs\/argon2 native runtime/u,
  );
});

test("production image verifier rejects an Argon2 runtime that cannot verify its own hash", async (context) => {
  const imageRoot = await mkdtemp(resolve(tmpdir(), "kokoro-platform-image-argon2-probe-"));
  context.after(() => rm(imageRoot, { recursive: true, force: true }));
  await writeImageLayout(imageRoot);
  const imageRequire = createRequire(resolve(imageRoot, "package.json"));
  await writeFile(
    imageRequire.resolve("@node-rs/argon2"),
    "module.exports = { hash: async () => 'invalid-probe', verify: async () => false };\n",
  );
  await assert.rejects(
    () => verifyProductionImage(imageRoot),
    /cannot load @node-rs\/argon2 native runtime/u,
  );
});

test("production image verifier rejects a missing Platform API composition contract", async (context) => {
  const imageRoot = await mkdtemp(resolve(tmpdir(), "kokoro-platform-image-api-contract-"));
  context.after(() => rm(imageRoot, { recursive: true, force: true }));
  await writeImageLayout(imageRoot);
  await rm(resolve(imageRoot, "dist/src/process/platform-api-runtime-contract.js"));
  await assert.rejects(() => verifyProductionImage(imageRoot), /missing compiled entrypoint/u);
});

test("production image verifier rejects a missing core single-Site prepare selector", async (context) => {
  const imageRoot = await mkdtemp(resolve(tmpdir(), "kokoro-platform-image-core-prepare-"));
  context.after(() => rm(imageRoot, { recursive: true, force: true }));
  await writeImageLayout(imageRoot);
  await rm(resolve(imageRoot, "dist/src/process/core-single-site-prepare.js"));
  await assert.rejects(() => verifyProductionImage(imageRoot), /missing compiled entrypoint/u);
});

test("production image verifier rejects a missing core single-Site bootstrap selector", async (context) => {
  const imageRoot = await mkdtemp(resolve(tmpdir(), "kokoro-platform-image-core-bootstrap-"));
  context.after(() => rm(imageRoot, { recursive: true, force: true }));
  await writeImageLayout(imageRoot);
  await rm(resolve(imageRoot, "dist/src/process/core-single-site-bootstrap.js"));
  await assert.rejects(() => verifyProductionImage(imageRoot), /missing compiled entrypoint/u);
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

test("production image verifier rejects a nested regular TypeScript executable", async (context) => {
  const imageRoot = await mkdtemp(resolve(tmpdir(), "kokoro-platform-image-nested-tsc-"));
  context.after(() => rm(imageRoot, { recursive: true, force: true }));
  await writeImageLayout(imageRoot);
  const nestedBin = resolve(
    imageRoot,
    "node_modules/.pnpm/@prisma+dev@fixture/node_modules/.bin",
  );
  await mkdir(nestedBin, { recursive: true });
  await writeFile(resolve(nestedBin, "tsc"), "#!/usr/bin/env node\n");
  await assert.rejects(
    () => verifyProductionImage(imageRoot),
    /development executable: .*\.bin\/tsc/u,
  );
});
