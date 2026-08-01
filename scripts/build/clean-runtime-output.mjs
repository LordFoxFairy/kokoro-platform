import { rm } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export async function cleanRuntimeOutput(projectRoot) {
  const resolvedRoot = resolve(projectRoot);
  const outputDirectory = resolve(resolvedRoot, "dist");
  if (relative(resolvedRoot, outputDirectory) !== "dist") {
    throw new Error("Runtime output must be the project-local dist directory");
  }
  await rm(outputDirectory, { recursive: true, force: true });
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) {
  await cleanRuntimeOutput(process.argv[2] ?? process.cwd());
}
