import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "../..");
const checkerUrl = pathToFileURL(
  resolve(root, "scripts/contract/check-production-source-boundary.mjs"),
).href;
const cleanerUrl = pathToFileURL(
  resolve(root, "scripts/build/clean-runtime-output.mjs"),
).href;

async function loadChecker() {
  const module = await import(checkerUrl);
  assert.equal(typeof module?.assertProductionSourceBoundary, "function",
    "production source boundary must expose a structured compiler-graph gate");
  return module.assertProductionSourceBoundary;
}

test("runtime build gates the compiler graph before TypeScript emission", async () => {
  const [manifest, config] = await Promise.all([
    readFile(resolve(root, "package.json"), "utf8").then(JSON.parse),
    readFile(resolve(root, "tsconfig.runtime.json"), "utf8").then(JSON.parse),
  ]);

  assert.equal(
    manifest.scripts["check:production-source-boundary"],
    "node scripts/contract/check-production-source-boundary.mjs .",
  );
  assert.equal(
    manifest.scripts["clean:runtime"],
    "node scripts/build/clean-runtime-output.mjs .",
  );
  const buildSteps = manifest.scripts["build:runtime"].split(" && ");
  assert.ok(
    buildSteps.indexOf("pnpm run check:production-source-boundary") <
      buildSteps.indexOf("tsc -p tsconfig.runtime.json"),
  );
  assert.ok(
    buildSteps.indexOf("pnpm run clean:runtime") <
      buildSteps.indexOf("tsc -p tsconfig.runtime.json"),
  );
  assert.ok(config.exclude.includes("src/modules/**/infrastructure/dev/**/*.ts"));
});

test("runtime output cleaner removes stale compiler artifacts only", async (context) => {
  const module = await import(cleanerUrl).catch(() => null);
  assert.equal(typeof module?.cleanRuntimeOutput, "function");
  const projectRoot = await mkdtemp(resolve(tmpdir(), "kokoro-runtime-output-"));
  context.after(() => rm(projectRoot, { recursive: true, force: true }));
  await mkdir(resolve(projectRoot, "dist/src/modules/example/infrastructure/dev"), { recursive: true });
  await mkdir(resolve(projectRoot, "src"), { recursive: true });
  await writeFile(resolve(projectRoot, "dist/src/modules/example/infrastructure/dev/fake.js"), "leak\n");
  await writeFile(resolve(projectRoot, "src/keep.ts"), "export {};\n");

  await module.cleanRuntimeOutput(projectRoot);

  await assert.rejects(() => access(resolve(projectRoot, "dist")), { code: "ENOENT" });
  await access(resolve(projectRoot, "src/keep.ts"));
});

test("runtime compiler graph excludes every module development adapter", async () => {
  const assertProductionSourceBoundary = await loadChecker();
  const report = await assertProductionSourceBoundary(root);

  assert.deepEqual(report.developmentOnlyFiles, [
    "src/modules/artifact/infrastructure/dev/in-memory-artifact-adapters.ts",
    "src/modules/media/infrastructure/dev/deterministic-image-provider.ts",
  ]);
  assert.ok(report.productionSourceFiles > 0);
});

test("runtime compiler graph rejects a production import of an excluded development adapter", async (context) => {
  const assertProductionSourceBoundary = await loadChecker();
  const projectRoot = await mkdtemp(resolve(tmpdir(), "kokoro-production-source-boundary-"));
  context.after(() => rm(projectRoot, { recursive: true, force: true }));

  await mkdir(resolve(projectRoot, "src/modules/example/infrastructure/dev"), { recursive: true });
  await mkdir(resolve(projectRoot, "src/process"), { recursive: true });
  await writeFile(resolve(projectRoot, "tsconfig.runtime.json"), JSON.stringify({
    compilerOptions: {
      module: "NodeNext",
      moduleResolution: "NodeNext",
      target: "ES2022",
      outDir: "dist",
    },
    include: ["src/**/*.ts"],
    exclude: ["src/modules/**/infrastructure/dev/**/*.ts"],
  }));
  await writeFile(
    resolve(projectRoot, "src/modules/example/infrastructure/dev/fake.ts"),
    "export const developmentOnly = true;\n",
  );
  await writeFile(
    resolve(projectRoot, "src/process/main.ts"),
    'import { developmentOnly } from "../modules/example/infrastructure/dev/fake.js";\n' +
      "export const leaked = developmentOnly;\n",
  );

  await assert.rejects(
    () => assertProductionSourceBoundary(projectRoot),
    /Production compiler graph includes development-only source:.*fake\.ts/u,
  );
});
