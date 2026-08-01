import { readdir } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const developmentOnlySourcePattern =
  /^src\/modules\/[^/]+\/infrastructure\/dev(?:\/|$)/u;

function normalizeRelativePath(projectRoot, filePath) {
  return relative(projectRoot, resolve(filePath)).replaceAll("\\", "/");
}

function formatConfigErrors(errors) {
  return errors.map((error) => ts.flattenDiagnosticMessageText(error.messageText, "\n")).join("\n");
}

async function collectDevelopmentOnlyFiles(projectRoot) {
  const modulesRoot = resolve(projectRoot, "src/modules");
  const found = [];

  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const entryPath = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(entryPath);
      } else if (entry.isFile()) {
        const relativePath = normalizeRelativePath(projectRoot, entryPath);
        if (developmentOnlySourcePattern.test(relativePath)) found.push(relativePath);
      }
    }
  }

  await walk(modulesRoot);
  return found.sort();
}

export async function assertProductionSourceBoundary(
  projectRoot,
  configName = "tsconfig.runtime.json",
) {
  const resolvedRoot = resolve(projectRoot);
  const configPath = resolve(resolvedRoot, configName);
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  if (config.error !== undefined) {
    throw new Error(`Production TypeScript config is invalid:\n${formatConfigErrors([config.error])}`);
  }

  const parsed = ts.parseJsonConfigFileContent(
    config.config,
    ts.sys,
    resolvedRoot,
    undefined,
    configPath,
  );
  if (parsed.errors.length > 0) {
    throw new Error(`Production TypeScript config is invalid:\n${formatConfigErrors(parsed.errors)}`);
  }

  const program = ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options });
  const compiledProjectFiles = program.getSourceFiles()
    .map((sourceFile) => normalizeRelativePath(resolvedRoot, sourceFile.fileName))
    .filter((filePath) => !filePath.startsWith("../") && !filePath.includes("/node_modules/"));
  const leaked = compiledProjectFiles.filter((filePath) =>
    developmentOnlySourcePattern.test(filePath)).sort();
  if (leaked.length > 0) {
    throw new Error(
      `Production compiler graph includes development-only source: ${leaked.join(", ")}`,
    );
  }

  return Object.freeze({
    configPath: normalizeRelativePath(resolvedRoot, configPath),
    productionSourceFiles: compiledProjectFiles.length,
    developmentOnlyFiles: Object.freeze(await collectDevelopmentOnlyFiles(resolvedRoot)),
  });
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) {
  const projectRoot = process.argv[2] ?? process.cwd();
  const report = await assertProductionSourceBoundary(projectRoot);
  console.log(
    `production_source_boundary_ok: ${report.productionSourceFiles} runtime sources, ` +
      `${report.developmentOnlyFiles.length} development-only sources excluded`,
  );
}
