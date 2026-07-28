import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
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

function assertProductionDockerfile(dockerfile) {
  assert.match(dockerfile, /^FROM .* AS build$/mu);
  assert.match(dockerfile, /^FROM .* AS prod-deps$/mu);
  assert.match(dockerfile, /^FROM .* AS runtime$/mu);
  assert.match(dockerfile, /RUN pnpm install --prod --frozen-lockfile --ignore-scripts/u);
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
    "kokoro-user/generated/prisma/index.d.ts",
    "kokoro-user/generated/prisma/schema.prisma",
    "kokoro-user/generated/prisma/runtime/library.js",
  ]) {
    await mkdir(resolve(imageRoot, entry, ".."), { recursive: true });
    await writeFile(resolve(imageRoot, entry), "");
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
});
