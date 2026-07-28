import { access, readdir } from "node:fs/promises";
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
