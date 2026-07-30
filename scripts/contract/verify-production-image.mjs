import { access, readFile, readdir, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const retiredPackages = Object.freeze([
  "kokoro-platform-admin",
  "kokoro-site",
  "kokoro-user",
  "kokoro-model",
  "kokoro-credit",
  "kokoro-payment",
]);
const forbiddenProductionPackages = Object.freeze([
  "tsx", "vitest", "vite", "eslint", "typescript",
  "@eslint+", "@vitest+", "@vitejs+",
]);
const workspaceLayouts = Object.freeze({
  "kokoro-platform-kit": new Set(["dist", "node_modules", "package.json"]),
  "kokoro-hub": new Set(["dist", "node_modules", "package.json"]),
});
const topLevelLayout = new Set([
  "deploy", "dist", "node_modules", "package.json", "prisma",
  ...Object.keys(workspaceLayouts),
]);
const requiredEntries = Object.freeze([
  "deploy/docker/runtime-entrypoint.mjs",
  "dist/prisma.config.js",
  "dist/src/generated/platform-prisma/client.js",
  "dist/src/infrastructure/postgres/migrator.js",
  "dist/src/process/api.js",
  "dist/src/process/admission.js",
  "dist/src/process/admin.js",
  "dist/src/process/admin-authority-bootstrap.js",
  "dist/src/process/asset-data-plane.js",
  "dist/src/process/authorization.js",
  "dist/src/process/model-gateway.js",
  "dist/src/process/worker.js",
  "prisma/schema.prisma",
  "prisma/migrations/migration_lock.toml",
  "node_modules/prisma/build/index.js",
  "kokoro-platform-kit/dist/index.js",
  "kokoro-hub/dist/interfaces/http/main.js",
  "kokoro-hub/dist/interfaces/connect/main.js",
]);
const developmentTreePattern = /(?:^|[-_.])(?:src|test|tests|coverage|dev)(?:$|[-_.])/u;

async function exists(path) {
  return access(path).then(() => true, () => false);
}

async function assertAllowedChildren(directory, allowed, label) {
  for (const entry of await readdir(directory)) {
    if (!allowed.has(entry)) {
      throw new Error(`Production image contains unexpected image path: ${label}/${entry}`);
    }
  }
}

async function assertRuntimeTree(directory, label) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = `${label}/${entry.name}`;
    if (entry.isDirectory()) {
      if (developmentTreePattern.test(entry.name)) {
        throw new Error(`Production image contains development tree: ${relative}`);
      }
      await assertRuntimeTree(resolve(directory, entry.name), relative);
    } else if (!entry.isFile() || /(?:\.tsx?|\.map|\.tsbuildinfo)$/u.test(entry.name)) {
      throw new Error(`Production image contains source artifact: ${relative}`);
    } else if ((await stat(resolve(directory, entry.name))).size === 0) {
      throw new Error(`Production image contains empty runtime artifact: ${relative}`);
    }
  }
}

async function assertMigrations(root) {
  const directory = resolve(root, "prisma/migrations");
  const entries = await readdir(directory, { withFileTypes: true });
  const migrations = entries.filter((entry) => entry.isDirectory());
  if (migrations.length < 1 || !entries.some((entry) => entry.isFile() && entry.name === "migration_lock.toml")) {
    throw new Error("Production image is missing PostgreSQL migrations");
  }
  for (const entry of entries) {
    if (entry.isFile()) {
      if (entry.name !== "migration_lock.toml") {
        throw new Error(`Production image contains unexpected migration artifact: ${entry.name}`);
      }
      continue;
    }
    if (!entry.isDirectory() || !/^[0-9][0-9A-Za-z_]+$/u.test(entry.name)) {
      throw new Error(`Production image contains invalid migration directory: ${entry.name}`);
    }
    await assertAllowedChildren(resolve(directory, entry.name), new Set(["migration.sql"]),
      `prisma/migrations/${entry.name}`);
    if (!(await exists(resolve(directory, entry.name, "migration.sql")))) {
      throw new Error(`Production image is missing migration.sql: ${entry.name}`);
    }
  }
}

async function assertManifest(root) {
  const manifest = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
  const dependencies = Object.keys(manifest.dependencies ?? {});
  for (const retired of ["@kokoro/site", "@kokoro/user", "@kokoro/model", "@kokoro/credit",
    "@kokoro/payment", "@kokoro/platform-admin", "mysql2"]) {
    if (dependencies.includes(retired)) {
      throw new Error(`Production image manifest retains retired dependency: ${retired}`);
    }
  }
}

export async function verifyProductionImage(root) {
  await assertAllowedChildren(root, topLevelLayout, ".");
  for (const retired of retiredPackages) {
    if (await exists(resolve(root, retired))) {
      throw new Error(`Production image contains retired runtime package: ${retired}`);
    }
  }
  for (const [workspace, allowed] of Object.entries(workspaceLayouts)) {
    await assertAllowedChildren(resolve(root, workspace), allowed, workspace);
    await assertRuntimeTree(resolve(root, workspace, "dist"), `${workspace}/dist`);
  }
  await assertAllowedChildren(resolve(root, "deploy"), new Set(["docker"]), "deploy");
  await assertAllowedChildren(resolve(root, "deploy/docker"), new Set(["runtime-entrypoint.mjs"]),
    "deploy/docker");
  await assertAllowedChildren(resolve(root, "prisma"), new Set(["migrations", "schema.prisma"]),
    "prisma");
  await assertAllowedChildren(resolve(root, "dist"), new Set(["prisma.config.js", "src"]), "dist");
  await assertRuntimeTree(resolve(root, "dist/src"), "platform-runtime");
  await assertMigrations(root);
  await assertManifest(root);

  const installed = await readdir(resolve(root, "node_modules/.pnpm"));
  const leaked = installed.filter((entry) => forbiddenProductionPackages.some((name) =>
    entry === name || entry.startsWith(`${name}@`) || entry.startsWith(name)));
  if (leaked.length > 0) {
    throw new Error(`Production image contains forbidden package: ${leaked.sort().join(", ")}`);
  }
  const executableDirectory = resolve(root, "node_modules/.bin");
  const executables = (await exists(executableDirectory)) ? await readdir(executableDirectory) : [];
  const leakedExecutables = executables.filter((entry) =>
    ["tsx", "vitest", "vite", "eslint", "tsc"].includes(entry));
  if (leakedExecutables.length > 0) {
    throw new Error(`Production image contains development executable: ${leakedExecutables.sort().join(", ")}`);
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
