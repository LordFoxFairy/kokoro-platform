import { Buffer } from "node:buffer";
import { access, open, readFile, readdir, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const forbiddenPackages = Object.freeze([
  "tsx",
  "vitest",
  "vite",
  "eslint",
  "typescript",
  "@eslint+",
  "@vitest+",
  "@vitejs+",
]);
const workspaceLayouts = Object.freeze({
  "kokoro-platform-kit": new Set(["dist", "node_modules", "package.json"]),
  "kokoro-platform-admin": new Set(["dist", "generated", "node_modules", "package.json", "public"]),
  "kokoro-site": new Set(["dist", "generated", "node_modules", "package.json"]),
  "kokoro-user": new Set(["dist", "generated", "node_modules", "package.json"]),
  "kokoro-hub": new Set(["dist", "node_modules", "package.json"]),
  "kokoro-model": new Set(["dist", "generated", "node_modules", "package.json"]),
  "kokoro-credit": new Set(["dist", "generated", "node_modules", "package.json"]),
  "kokoro-payment": new Set(["dist", "generated", "node_modules", "package.json"]),
});
const topLevelLayout = new Set(["deploy", "node_modules", "package.json", ...Object.keys(workspaceLayouts)]);
const developmentTreePattern = /(?:^|[-_.])(?:src|test|tests|coverage|dev)(?:$|[-_.])/u;
const prismaRootFiles = new Set([
  "client.d.ts",
  "client.js",
  "default.d.ts",
  "default.js",
  "edge.d.ts",
  "edge.js",
  "index-browser.js",
  "index.d.ts",
  "index.js",
  "package.json",
  "query_engine_bg.js",
  "query_engine_bg.wasm",
  "schema.prisma",
  "wasm-edge-light-loader.mjs",
  "wasm-worker-loader.mjs",
  "wasm.d.ts",
  "wasm.js",
]);
const prismaRuntimeFiles = new Set([
  "edge-esm.js",
  "edge.js",
  "index-browser.d.ts",
  "index-browser.js",
  "library.d.ts",
  "library.js",
  "react-native.js",
  "wasm-compiler-edge.js",
  "wasm-engine-edge.js",
]);
const prismaNativeEngine = "libquery_engine-debian-openssl-3.0.x.so.node";
const prismaWasmEngine = "query_engine_bg.wasm";
const prismaClientVersion = "6.19.3";
const elfMagic = Buffer.from([0x7f, 0x45, 0x4c, 0x46]);
const wasmMagic = Buffer.from([0x00, 0x61, 0x73, 0x6d]);
const requiredEntries = Object.freeze([
  "deploy/docker/runtime-entrypoint.mjs",
  "kokoro-platform-kit/dist/index.js",
  "kokoro-site/dist/interfaces/http/main.js",
  "kokoro-user/dist/interfaces/http/main.js",
  "kokoro-model/dist/interfaces/http/main.js",
  "kokoro-credit/dist/interfaces/http/main.js",
  "kokoro-payment/dist/interfaces/http/main.js",
  "kokoro-hub/dist/interfaces/http/main.js",
  "kokoro-platform-admin/dist/main.js",
]);

async function exists(path) {
  return access(path).then(
    () => true,
    () => false,
  );
}

async function assertAllowedChildren(directory, allowed, label) {
  if (!(await exists(directory))) return;
  for (const entry of await readdir(directory)) {
    if (!allowed.has(entry)) {
      throw new Error(`Production image contains unexpected image path: ${label}/${entry}`);
    }
  }
}

function isSourceArtifact(filename) {
  return /(?:\.tsx?|\.map|\.tsbuildinfo)$/u.test(filename);
}

async function assertRuntimeTree(directory, label) {
  if (!(await exists(directory))) return;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = `${label}/${entry.name}`;
    if (entry.isDirectory()) {
      if (developmentTreePattern.test(entry.name)) {
        throw new Error(`Production image contains development tree: ${relative}`);
      }
      await assertRuntimeTree(resolve(directory, entry.name), relative);
    } else if (!entry.isFile() || isSourceArtifact(entry.name)) {
      throw new Error(`Production image contains source artifact: ${relative}`);
    }
  }
}

async function assertNonEmptyFile(path, label) {
  if ((await stat(path)).size === 0) {
    throw new Error(`Production image contains empty generated Prisma runtime: ${label}`);
  }
}

async function assertBinaryMagic(path, expectedMagic, label) {
  const handle = await open(path, "r");
  try {
    const metadata = await handle.stat();
    const prefix = Buffer.alloc(expectedMagic.length);
    const { bytesRead } = await handle.read(prefix, 0, prefix.length, 0);
    if (metadata.size <= expectedMagic.length || bytesRead !== expectedMagic.length || !prefix.equals(expectedMagic)) {
      throw new Error(`Production image contains invalid generated Prisma ${label}`);
    }
  } finally {
    await handle.close();
  }
}

async function assertPrismaPackage(path, label) {
  const raw = await readFile(path, "utf8");
  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch {
    throw new Error(`Production image contains invalid generated Prisma package: ${label}`);
  }
  const valid =
    raw.trim().length > 0 &&
    typeof manifest === "object" &&
    manifest !== null &&
    !Array.isArray(manifest) &&
    /^prisma-client-[a-f0-9]{64}$/u.test(manifest.name) &&
    manifest.main === "index.js" &&
    manifest.types === "index.d.ts" &&
    manifest.browser === "default.js" &&
    manifest.version === prismaClientVersion &&
    manifest.sideEffects === false;
  if (!valid) {
    throw new Error(`Production image contains invalid generated Prisma package: ${label}`);
  }
}

async function assertGeneratedPrisma(directory, label) {
  if (!(await exists(directory))) return;
  const generatedEntries = await readdir(directory, { withFileTypes: true });
  if (
    generatedEntries.length !== 1 ||
    generatedEntries[0].name !== "prisma" ||
    !generatedEntries[0].isDirectory()
  ) {
    throw new Error(`Production image contains unexpected generated Prisma file: ${label}`);
  }

  const prismaDirectory = resolve(directory, "prisma");
  const rootFiles = new Set();
  let hasRuntimeLibrary = false;
  for (const entry of await readdir(prismaDirectory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (entry.name !== "runtime") {
        throw new Error(`Production image contains unexpected generated Prisma file: ${label}/prisma/${entry.name}`);
      }
      for (const runtimeEntry of await readdir(resolve(prismaDirectory, "runtime"), { withFileTypes: true })) {
        if (!runtimeEntry.isFile() || !prismaRuntimeFiles.has(runtimeEntry.name)) {
          throw new Error(
            `Production image contains unexpected generated Prisma file: ${label}/prisma/runtime/${runtimeEntry.name}`,
          );
        }
        if (runtimeEntry.name === "library.js") hasRuntimeLibrary = true;
      }
      continue;
    }
    if (entry.name.endsWith(".node")) {
      if (!entry.isFile() || entry.name !== prismaNativeEngine) {
        throw new Error(`Production image contains unexpected generated Prisma native engine: ${label}/prisma/${entry.name}`);
      }
      rootFiles.add(entry.name);
      continue;
    }
    if (entry.name.endsWith(".wasm")) {
      if (!entry.isFile() || entry.name !== prismaWasmEngine) {
        throw new Error(`Production image contains unexpected generated Prisma Wasm engine: ${label}/prisma/${entry.name}`);
      }
      rootFiles.add(entry.name);
      continue;
    }
    if (!entry.isFile() || !prismaRootFiles.has(entry.name)) {
      throw new Error(`Production image contains unexpected generated Prisma file: ${label}/prisma/${entry.name}`);
    }
    rootFiles.add(entry.name);
  }
  for (const required of ["index.js", "package.json"]) {
    if (!rootFiles.has(required)) {
      throw new Error(`Production image is missing generated Prisma runtime: ${label}/prisma/${required}`);
    }
  }
  if (!hasRuntimeLibrary) {
    throw new Error(`Production image is missing generated Prisma runtime: ${label}/prisma/runtime/library.js`);
  }
  if (!rootFiles.has(prismaNativeEngine)) {
    throw new Error(`Production image is missing generated Prisma engine: ${label}/prisma`);
  }
  if (!rootFiles.has(prismaWasmEngine)) {
    throw new Error(`Production image is missing generated Prisma Wasm engine: ${label}/prisma`);
  }

  await assertNonEmptyFile(resolve(prismaDirectory, "index.js"), `${label}/prisma/index.js`);
  await assertNonEmptyFile(
    resolve(prismaDirectory, "runtime/library.js"),
    `${label}/prisma/runtime/library.js`,
  );
  await assertPrismaPackage(resolve(prismaDirectory, "package.json"), `${label}/prisma/package.json`);
  await assertBinaryMagic(
    resolve(prismaDirectory, prismaNativeEngine),
    elfMagic,
    `native engine: ${label}/prisma/${prismaNativeEngine}`,
  );
  await assertBinaryMagic(
    resolve(prismaDirectory, prismaWasmEngine),
    wasmMagic,
    `Wasm engine: ${label}/prisma/${prismaWasmEngine}`,
  );
}

export async function verifyProductionImage(root) {
  await assertAllowedChildren(root, topLevelLayout, ".");
  for (const [workspace, allowed] of Object.entries(workspaceLayouts)) {
    await assertAllowedChildren(resolve(root, workspace), allowed, workspace);
  }
  await assertAllowedChildren(resolve(root, "deploy"), new Set(["docker"]), "deploy");
  await assertAllowedChildren(
    resolve(root, "deploy/docker"),
    new Set(["runtime-entrypoint.mjs"]),
    "deploy/docker",
  );
  for (const [workspace, allowed] of Object.entries(workspaceLayouts)) {
    await assertRuntimeTree(resolve(root, workspace, "dist"), `${workspace}/dist`);
    if (allowed.has("public")) {
      await assertRuntimeTree(resolve(root, workspace, "public"), `${workspace}/public`);
    }
    if (allowed.has("generated")) {
      await assertGeneratedPrisma(resolve(root, workspace, "generated"), `${workspace}/generated`);
    }
  }

  const installed = await readdir(resolve(root, "node_modules/.pnpm"));
  const leaked = installed.filter((entry) =>
    forbiddenPackages.some((name) => entry === name || entry.startsWith(`${name}@`) || entry.startsWith(name)),
  );
  if (leaked.length > 0) {
    throw new Error(`Production image contains development packages: ${leaked.sort().join(", ")}`);
  }
  const executableDirectory = resolve(root, "node_modules/.bin");
  const executables = (await exists(executableDirectory)) ? await readdir(executableDirectory) : [];
  const leakedExecutables = executables.filter((entry) =>
    ["tsx", "vitest", "vite", "eslint", "tsc"].includes(entry),
  );
  if (leakedExecutables.length > 0) {
    throw new Error(
      `Production image contains development executable: ${leakedExecutables.sort().join(", ")}`,
    );
  }
  for (const entry of requiredEntries) {
    if (!(await exists(resolve(root, entry)))) {
      throw new Error(`Production image is missing compiled entrypoint: ${entry}`);
    }
  }
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) {
  const root = process.argv[2];
  if (root === undefined || root.length === 0) {
    throw new Error("Usage: verify-production-image.mjs <image-root>");
  }
  await verifyProductionImage(resolve(root));
}
