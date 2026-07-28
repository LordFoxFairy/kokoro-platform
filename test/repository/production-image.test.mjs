import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { verifyProductionImage } from "../../scripts/contract/verify-production-image.mjs";

const root = resolve(import.meta.dirname, "../..");

test("the final Platform image contains only compiled production dependencies", async () => {
  const dockerfile = await readFile(resolve(root, "deploy/docker/Dockerfile"), "utf8");

  assert.match(dockerfile, /^FROM .* AS build$/mu);
  assert.match(dockerfile, /^FROM .* AS prod-deps$/mu);
  assert.match(dockerfile, /^FROM .* AS runtime$/mu);
  assert.match(
    dockerfile,
    /RUN pnpm install --prod --frozen-lockfile --ignore-scripts/u,
  );
  assert.match(dockerfile, /COPY .*--from=prod-deps .*node_modules/u);
  for (const workspace of [
    "kokoro-platform-kit",
    "kokoro-platform-admin",
    "kokoro-site",
    "kokoro-user",
    "kokoro-hub",
    "kokoro-model",
    "kokoro-credit",
    "kokoro-payment",
  ]) {
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
  assert.match(
    dockerfile,
    /RUN node \/opt\/kokoro\/verify-production-image\.mjs \/app/u,
  );
  assert.match(
    dockerfile,
    /CMD \["node", "--conditions=kokoro-runtime", "deploy\/runtime-entrypoint\.mjs"\]/u,
  );

  const runtime = dockerfile.slice(dockerfile.search(/^FROM .* AS runtime$/mu));
  assert.doesNotMatch(runtime, /pnpm install(?! --prod)/u);
  assert.doesNotMatch(runtime, /\btsx\b/u);
  assert.doesNotMatch(runtime, /^COPY \. \.$/mu);
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
