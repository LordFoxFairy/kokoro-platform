import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { parse } from "yaml";
import { verifyProductionImage } from "../../scripts/contract/verify-production-image.mjs";

const root = resolve(import.meta.dirname, "../..");
const workspaces = Object.freeze([
  "kokoro-platform-kit",
  "kokoro-platform-admin",
  "kokoro-site",
  "kokoro-user",
  "kokoro-hub",
  "kokoro-model",
  "kokoro-credit",
  "kokoro-payment",
]);
const debianPrismaEngine = "libquery_engine-debian-openssl-3.0.x.so.node";
const validPrismaPackage = Object.freeze({
  name: "prisma-client-bd010cc3e43281e2eea859ccf831a3d2246b75993ee63faf03053dde6c1a2739",
  main: "index.js",
  types: "index.d.ts",
  browser: "default.js",
  version: "6.19.3",
  sideEffects: false,
});

async function writeMinimalImageLayout(imageRoot) {
  await mkdir(resolve(imageRoot, "node_modules/.pnpm/fastify@5.10.0"), { recursive: true });
  for (const entry of [
    "deploy/docker/runtime-entrypoint.mjs",
    "kokoro-platform-kit/dist/index.js",
    "kokoro-site/dist/interfaces/http/main.js",
    "kokoro-user/dist/interfaces/http/main.js",
    "kokoro-model/dist/interfaces/http/main.js",
    "kokoro-credit/dist/interfaces/http/main.js",
    "kokoro-payment/dist/interfaces/http/main.js",
    "kokoro-hub/dist/interfaces/http/main.js",
    "kokoro-platform-admin/dist/main.js",
  ]) {
    await mkdir(resolve(imageRoot, entry, ".."), { recursive: true });
    await writeFile(resolve(imageRoot, entry), "export {};\n");
  }
}

async function writeValidPrismaFixture(imageRoot) {
  const prismaRoot = resolve(imageRoot, "kokoro-user/generated/prisma");
  await mkdir(resolve(prismaRoot, "runtime"), { recursive: true });
  await writeFile(resolve(prismaRoot, "index.js"), "module.exports = { PrismaClient: class PrismaClient {} };\n");
  await writeFile(resolve(prismaRoot, "index.d.ts"), "export declare class PrismaClient {}\n");
  await writeFile(resolve(prismaRoot, "package.json"), `${JSON.stringify(validPrismaPackage)}\n`);
  await writeFile(resolve(prismaRoot, "schema.prisma"), "generator client { provider = \"prisma-client-js\" }\n");
  await writeFile(resolve(prismaRoot, "runtime/library.js"), "module.exports = { getPrismaClient() {} };\n");
  await writeFile(resolve(prismaRoot, debianPrismaEngine), Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x01]));
  await writeFile(resolve(prismaRoot, "query_engine_bg.wasm"), Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01]));
  return prismaRoot;
}

function assertProductionDockerfile(dockerfile) {
  assert.match(dockerfile, /^FROM .* AS build$/mu);
  assert.match(dockerfile, /^FROM .* AS prod-deps$/mu);
  assert.match(dockerfile, /^FROM .* AS runtime$/mu);
  const buildStage = dockerfile.slice(
    dockerfile.search(/^FROM .* AS build$/mu),
    dockerfile.search(/^FROM .* AS prod-deps$/mu),
  );
  const buildInstallCommands = [...buildStage.matchAll(/^RUN (pnpm install[^\n]+)$/gmu)].map((match) => match[1]);
  assert.deepEqual(buildInstallCommands, [
    "pnpm install --config.auto-install-peers=false --frozen-lockfile --ignore-scripts",
  ]);
  const prodDeps = dockerfile.slice(
    dockerfile.search(/^FROM .* AS prod-deps$/mu),
    dockerfile.search(/^FROM .* AS runtime$/mu),
  );
  const prodInstallCommands = [...prodDeps.matchAll(/^RUN (pnpm install[^\n]+)$/gmu)].map((match) => match[1]);
  assert.deepEqual(prodInstallCommands, [
    "pnpm install --prod --no-optional --config.auto-install-peers=false --frozen-lockfile --ignore-scripts",
  ]);
  assert.match(dockerfile, /COPY .*--from=prod-deps .*node_modules/u);
  for (const workspace of workspaces) {
    assert.match(
      dockerfile,
      new RegExp(
        `COPY .*--from=prod-deps /app/${workspace}/node_modules ./${workspace}/node_modules`,
        "u",
      ),
      `${workspace} production dependency links must be present in the runtime image`,
    );
  }
  assert.match(dockerfile, /COPY .*--from=build .*\/dist/u);
  assert.match(dockerfile, /pnpm db:generate && pnpm build:runtime/u);
  for (const workspace of [
    "kokoro-platform-admin",
    "kokoro-site",
    "kokoro-user",
    "kokoro-model",
    "kokoro-credit",
    "kokoro-payment",
  ]) {
    assert.match(
      dockerfile,
      new RegExp(`COPY .*--from=build /app/${workspace}/generated ./${workspace}/generated`, "u"),
    );
  }
  assert.match(dockerfile, /RUN node \/opt\/kokoro\/verify-production-image\.mjs \/app/u);

  const runtime = dockerfile.slice(dockerfile.search(/^FROM .* AS runtime$/mu));
  const commandMatches = [...runtime.matchAll(/^CMD\s+(\[[^\n]+\])$/gmu)];
  assert.equal(commandMatches.length, 1, "runtime stage must contain exactly one JSON-form CMD");
  const command = JSON.parse(commandMatches[0][1]);
  assert.deepEqual(command, [
    "node",
    "--conditions=kokoro-runtime",
    "deploy/docker/runtime-entrypoint.mjs",
  ]);

  const target = command.at(-1);
  const copies = [...runtime.matchAll(/^COPY(?:\s+--[^\s]+)*\s+([^\s]+)\s+([^\s]+)$/gmu)];
  const developmentSegment = /(?:^|[-_.])(?:src|test|tests|coverage|dev)(?:$|[-_.])/u;
  for (const copy of copies) {
    const [source, destination] = [copy[1], copy[2]].map((value) => value.replace(/^\.\//u, ""));
    const paths = [source, destination];
    assert.equal(
      paths.some((path) => /(?:\.tsx?|\.map)$/u.test(path) || path.split("/").some((segment) => developmentSegment.test(segment))),
      false,
      `runtime COPY must not include development source: ${source} -> ${destination}`,
    );
  }
  const entrypointCopy = copies.find((match) => match[2].replace(/^\.\//u, "") === target);
  assert.ok(entrypointCopy, `runtime CMD target ${target} must be copied to the same image path`);
  assert.equal(entrypointCopy[1], target, "runtime entrypoint source and destination must stay aligned");

  assert.doesNotMatch(runtime, /pnpm install(?! --prod)/u);
  assert.doesNotMatch(runtime, /\btsx\b/u);
  assert.doesNotMatch(runtime, /^COPY \. \.$/mu);
  return target;
}

test("the final Platform image contains only compiled production dependencies", async () => {
  const dockerfile = await readFile(resolve(root, "deploy/docker/Dockerfile"), "utf8");
  const legacyPnpmConfig = await readFile(resolve(root, ".npmrc"), "utf8").catch(() => null);
  const lockfile = parse(await readFile(resolve(root, "pnpm-lock.yaml"), "utf8"));
  const workspaceConfig = parse(await readFile(resolve(root, "pnpm-workspace.yaml"), "utf8"));
  assert.equal(legacyPnpmConfig, null, "pnpm v11 install settings must not be placed in .npmrc");
  assert.equal(workspaceConfig.autoInstallPeers, false);
  assert.equal(lockfile.settings?.autoInstallPeers, false);
  const target = assertProductionDockerfile(dockerfile);
  await access(resolve(root, target));
});

test("the artifact gate rejects a targeted runtime entrypoint COPY mutation", async () => {
  const dockerfile = await readFile(resolve(root, "deploy/docker/Dockerfile"), "utf8");
  const mutated = dockerfile.replace(
    "deploy/docker/runtime-entrypoint.mjs ./deploy/docker/runtime-entrypoint.mjs",
    "deploy/docker/runtime-entrypoint.mjs ./deploy/runtime-entrypoint.mjs",
  );
  assert.notEqual(mutated, dockerfile, "mutation fixture must alter the entrypoint COPY");
  assert.throws(() => assertProductionDockerfile(mutated), /must be copied to the same image path/u);
});

test("the artifact gate rejects source and disguised source-tree COPY mutations", async () => {
  const dockerfile = await readFile(resolve(root, "deploy/docker/Dockerfile"), "utf8");
  const marker = "RUN node /opt/kokoro/verify-production-image.mjs /app";
  const mutations = [
    "COPY --from=build /app/kokoro-user/src/index.ts ./kokoro-user/dist/leaked-source.ts",
    "COPY --from=build /app/kokoro-user/src ./kokoro-user/dist/leaked-src",
  ];
  for (const copy of mutations) {
    const mutated = dockerfile.replace(marker, `${copy}\n${marker}`);
    assert.notEqual(mutated, dockerfile, "mutation fixture must add a runtime COPY");
    assert.throws(() => assertProductionDockerfile(mutated), /runtime COPY|development source/u);
  }
});

test("the artifact gate rejects production installs that restore optional peer tooling", async () => {
  const dockerfile = await readFile(resolve(root, "deploy/docker/Dockerfile"), "utf8");
  const expected =
    "pnpm install --prod --no-optional --config.auto-install-peers=false --frozen-lockfile --ignore-scripts";
  for (const mutation of [
    expected.replace(" --no-optional", ""),
    expected.replace(" --config.auto-install-peers=false", ""),
    expected.replace("auto-install-peers=false", "auto-install-peers=true"),
  ]) {
    const mutated = dockerfile.replace(expected, mutation);
    assert.notEqual(mutated, dockerfile, "mutation fixture must alter the prod-deps install");
    assert.throws(() => assertProductionDockerfile(mutated));
  }
});

test("the runtime entrypoint and image verifier reject dev-tool leakage", async () => {
  const entrypoint = await readFile(
    resolve(root, "deploy/docker/runtime-entrypoint.mjs"),
    "utf8",
  ).catch(() => "");
  const verifier = await readFile(
    resolve(root, "scripts/contract/verify-production-image.mjs"),
    "utf8",
  ).catch(() => "");

  assert.notEqual(entrypoint, "", "runtime entrypoint must exist");
  assert.notEqual(verifier, "", "image verifier must exist");
  assert.doesNotMatch(entrypoint, /\b(?:pnpm|tsx|vitest|vite|eslint|typescript)\b/u);
  for (const forbidden of ["tsx", "vitest", "vite", "eslint", "typescript"]) {
    assert.match(verifier, new RegExp(`(?:^|["'])${forbidden}(?:["']|$)`, "u"));
  }
});

test("the image verifier rejects a leaked development executable", async (context) => {
  const imageRoot = await mkdtemp(resolve(tmpdir(), "kokoro-platform-image-"));
  context.after(async () => rm(imageRoot, { recursive: true, force: true }));
  await mkdir(resolve(imageRoot, "node_modules/.pnpm/fastify@5.10.0"), { recursive: true });
  await mkdir(resolve(imageRoot, "node_modules/.bin"), { recursive: true });
  await writeFile(resolve(imageRoot, "node_modules/.bin/tsx"), "#!/bin/sh\n");
  for (const entry of [
    "kokoro-site/dist/interfaces/http/main.js",
    "kokoro-user/dist/interfaces/http/main.js",
    "kokoro-model/dist/interfaces/http/main.js",
    "kokoro-credit/dist/interfaces/http/main.js",
    "kokoro-payment/dist/interfaces/http/main.js",
    "kokoro-hub/dist/interfaces/http/main.js",
    "kokoro-platform-admin/dist/main.js",
  ]) {
    await mkdir(resolve(imageRoot, entry, ".."), { recursive: true });
    await writeFile(resolve(imageRoot, entry), "");
  }

  await assert.rejects(() => verifyProductionImage(imageRoot), /development executable/u);
});

test("the image verifier rejects development trees in every workspace", async (context) => {
  const imageRoot = await mkdtemp(resolve(tmpdir(), "kokoro-platform-image-layout-"));
  context.after(async () => rm(imageRoot, { recursive: true, force: true }));
  await mkdir(resolve(imageRoot, "node_modules/.pnpm/fastify@5.10.0"), { recursive: true });
  for (const entry of [
    "deploy/docker/runtime-entrypoint.mjs",
    "kokoro-platform-kit/dist/index.js",
    "kokoro-site/dist/interfaces/http/main.js",
    "kokoro-user/dist/interfaces/http/main.js",
    "kokoro-model/dist/interfaces/http/main.js",
    "kokoro-credit/dist/interfaces/http/main.js",
    "kokoro-payment/dist/interfaces/http/main.js",
    "kokoro-hub/dist/interfaces/http/main.js",
    "kokoro-platform-admin/dist/main.js",
  ]) {
    await mkdir(resolve(imageRoot, entry, ".."), { recursive: true });
    await writeFile(resolve(imageRoot, entry), "");
  }
  await verifyProductionImage(imageRoot);

  for (const workspace of workspaces) {
    for (const developmentTree of ["src", "test", "coverage"]) {
      const leaked = resolve(imageRoot, workspace, developmentTree);
      await mkdir(leaked, { recursive: true });
      await writeFile(resolve(leaked, "leaked.ts"), "");
      await assert.rejects(
        () => verifyProductionImage(imageRoot),
        /development tree|unexpected image path/u,
        `${workspace}/${developmentTree} must be rejected`,
      );
      await rm(leaked, { recursive: true });
    }
  }
});

test("the image verifier rejects unexpected top-level application files", async (context) => {
  const imageRoot = await mkdtemp(resolve(tmpdir(), "kokoro-platform-image-allowlist-"));
  context.after(async () => rm(imageRoot, { recursive: true, force: true }));
  await mkdir(resolve(imageRoot, "node_modules/.pnpm/fastify@5.10.0"), { recursive: true });
  for (const entry of [
    "deploy/docker/runtime-entrypoint.mjs",
    "kokoro-platform-kit/dist/index.js",
    "kokoro-site/dist/interfaces/http/main.js",
    "kokoro-user/dist/interfaces/http/main.js",
    "kokoro-model/dist/interfaces/http/main.js",
    "kokoro-credit/dist/interfaces/http/main.js",
    "kokoro-payment/dist/interfaces/http/main.js",
    "kokoro-hub/dist/interfaces/http/main.js",
    "kokoro-platform-admin/dist/main.js",
  ]) {
    await mkdir(resolve(imageRoot, entry, ".."), { recursive: true });
    await writeFile(resolve(imageRoot, entry), "");
  }
  await writeFile(resolve(imageRoot, "tsconfig.json"), "{}");
  await assert.rejects(() => verifyProductionImage(imageRoot), /unexpected image path/u);
});

test("the image verifier recursively rejects source artifacts and disguised dev trees", async (context) => {
  const imageRoot = await mkdtemp(resolve(tmpdir(), "kokoro-platform-image-recursive-"));
  context.after(async () => rm(imageRoot, { recursive: true, force: true }));
  await mkdir(resolve(imageRoot, "node_modules/.pnpm/fastify@5.10.0"), { recursive: true });
  for (const entry of [
    "deploy/docker/runtime-entrypoint.mjs",
    "kokoro-platform-kit/dist/index.js",
    "kokoro-site/dist/interfaces/http/main.js",
    "kokoro-user/dist/interfaces/http/main.js",
    "kokoro-model/dist/interfaces/http/main.js",
    "kokoro-credit/dist/interfaces/http/main.js",
    "kokoro-payment/dist/interfaces/http/main.js",
    "kokoro-hub/dist/interfaces/http/main.js",
    "kokoro-platform-admin/dist/main.js",
    "kokoro-platform-admin/public/index.html",
    "kokoro-user/generated/prisma/index.js",
    "kokoro-user/generated/prisma/index.d.ts",
    "kokoro-user/generated/prisma/package.json",
    "kokoro-user/generated/prisma/schema.prisma",
    `kokoro-user/generated/prisma/${debianPrismaEngine}`,
    "kokoro-user/generated/prisma/query_engine_bg.wasm",
    "kokoro-user/generated/prisma/runtime/library.js",
  ]) {
    await mkdir(resolve(imageRoot, entry, ".."), { recursive: true });
    const content = entry.endsWith(debianPrismaEngine)
      ? Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x01])
      : entry.endsWith("query_engine_bg.wasm")
        ? Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01])
        : entry.endsWith("package.json")
          ? `${JSON.stringify(validPrismaPackage)}\n`
          : "export {};\n";
    await writeFile(resolve(imageRoot, entry), content);
  }
  await verifyProductionImage(imageRoot);

  for (const workspace of workspaces) {
    const sourceFile = resolve(imageRoot, workspace, "dist/leaked-source.ts");
    await writeFile(sourceFile, "");
    await assert.rejects(() => verifyProductionImage(imageRoot), /source artifact/u);
    await rm(sourceFile);

    const disguisedTree = resolve(imageRoot, workspace, "dist/leaked-src");
    await mkdir(disguisedTree, { recursive: true });
    await writeFile(resolve(disguisedTree, "handler.js"), "");
    await assert.rejects(() => verifyProductionImage(imageRoot), /development tree/u);
    await rm(disguisedTree, { recursive: true });
  }

  for (const publicLeak of ["bundle.tsx", "bundle.js.map"]) {
    const leaked = resolve(imageRoot, "kokoro-platform-admin/public", publicLeak);
    await writeFile(leaked, "");
    await assert.rejects(() => verifyProductionImage(imageRoot), /source artifact/u);
    await rm(leaked);
  }

  const generatedLeak = resolve(imageRoot, "kokoro-user/generated/prisma/debug.txt");
  await writeFile(generatedLeak, "");
  await assert.rejects(() => verifyProductionImage(imageRoot), /unexpected generated Prisma file/u);
  await rm(generatedLeak);

  const generatedClient = resolve(imageRoot, "kokoro-user/generated/prisma/index.js");
  await rm(generatedClient);
  await assert.rejects(() => verifyProductionImage(imageRoot), /missing generated Prisma runtime/u);
  await writeFile(generatedClient, "export {};\n");

  const generatedEngine = resolve(imageRoot, `kokoro-user/generated/prisma/${debianPrismaEngine}`);
  await rm(generatedEngine);
  await assert.rejects(() => verifyProductionImage(imageRoot), /missing generated Prisma engine/u);
});

test("the image verifier rejects counterfeit or corrupt Prisma runtime artifacts", async (context) => {
  const cases = [
    {
      name: "zero-byte client entrypoint",
      mutate: (prismaRoot) => writeFile(resolve(prismaRoot, "index.js"), ""),
      error: /empty generated Prisma runtime/u,
    },
    {
      name: "zero-byte runtime library",
      mutate: (prismaRoot) => writeFile(resolve(prismaRoot, "runtime/library.js"), ""),
      error: /empty generated Prisma runtime/u,
    },
    {
      name: "zero-byte package metadata",
      mutate: (prismaRoot) => writeFile(resolve(prismaRoot, "package.json"), ""),
      error: /invalid generated Prisma package/u,
    },
    {
      name: "malformed package metadata",
      mutate: (prismaRoot) => writeFile(resolve(prismaRoot, "package.json"), "{"),
      error: /invalid generated Prisma package/u,
    },
    {
      name: "semantically invalid package metadata",
      mutate: (prismaRoot) => writeFile(resolve(prismaRoot, "package.json"), "{}\n"),
      error: /invalid generated Prisma package/u,
    },
    {
      name: "zero-byte native engine",
      mutate: (prismaRoot) => writeFile(resolve(prismaRoot, debianPrismaEngine), ""),
      error: /invalid generated Prisma native engine/u,
    },
    {
      name: "non-ELF native engine",
      mutate: (prismaRoot) => writeFile(resolve(prismaRoot, debianPrismaEngine), "not-elf"),
      error: /invalid generated Prisma native engine/u,
    },
    {
      name: "fake native engine name",
      mutate: async (prismaRoot) => {
        await rm(resolve(prismaRoot, debianPrismaEngine));
        await writeFile(resolve(prismaRoot, "libquery_engine-test.so.node"), Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x01]));
      },
      error: /unexpected generated Prisma native engine/u,
    },
    {
      name: "duplicate native engine",
      mutate: (prismaRoot) => writeFile(resolve(prismaRoot, "libquery_engine-copy.so.node"), Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x01])),
      error: /unexpected generated Prisma native engine/u,
    },
    {
      name: "zero-byte Wasm engine",
      mutate: (prismaRoot) => writeFile(resolve(prismaRoot, "query_engine_bg.wasm"), ""),
      error: /invalid generated Prisma Wasm engine/u,
    },
    {
      name: "non-Wasm engine",
      mutate: (prismaRoot) => writeFile(resolve(prismaRoot, "query_engine_bg.wasm"), "not-wasm"),
      error: /invalid generated Prisma Wasm engine/u,
    },
    {
      name: "duplicate Wasm engine",
      mutate: (prismaRoot) => writeFile(resolve(prismaRoot, "query_engine_copy.wasm"), Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01])),
      error: /unexpected generated Prisma Wasm engine/u,
    },
  ];

  for (const fixture of cases) {
    await context.test(fixture.name, async (childContext) => {
      const imageRoot = await mkdtemp(resolve(tmpdir(), "kokoro-platform-prisma-artifact-"));
      childContext.after(async () => rm(imageRoot, { recursive: true, force: true }));
      await writeMinimalImageLayout(imageRoot);
      const prismaRoot = await writeValidPrismaFixture(imageRoot);
      await fixture.mutate(prismaRoot);
      await assert.rejects(() => verifyProductionImage(imageRoot), fixture.error);
    });
  }
});
