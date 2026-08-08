import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { parse } from "yaml";

const root = resolve(import.meta.dirname, "../..");
const legacySourceDirectories = Object.freeze([
  "kokoro-platform-admin", "kokoro-site", "kokoro-user", "kokoro-model",
  "kokoro-credit", "kokoro-payment",
]);
const localBuildOutputs = new Set(["dist", "generated", "node_modules"]);

async function sourceTreeEntries(directory) {
  try {
    const entries = await readdir(resolve(root, directory), { withFileTypes: true });
    const nested = await Promise.all(entries.map(async (entry) => {
      if (localBuildOutputs.has(entry.name)) return [];
      const relative = `${directory}/${entry.name}`;
      return entry.isDirectory() ? sourceTreeEntries(relative) : [relative];
    }));
    return nested.flat().sort();
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

function workflowJobs(source) {
  const document = parse(source);
  assert.ok(document && typeof document === "object" && !Array.isArray(document));
  assert.ok(document.jobs && typeof document.jobs === "object" && !Array.isArray(document.jobs));
  return document.jobs;
}

function commands(job) {
  assert.ok(job && Array.isArray(job.steps));
  return job.steps.flatMap((step) => typeof step?.run === "string" ? [step.run] : []);
}

test("Platform CI gates both PostgreSQL authority and Hub integration", async () => {
  const source = await readFile(resolve(root, ".github/workflows/ci.yml"), "utf8");
  const jobs = workflowJobs(source);
  const gates = jobs.gates;
  const hubIntegration = jobs["hub-integration"];
  const platformPostgres = jobs["platform-postgres"];
  const artifact = jobs.artifact;
  assert.ok(gates && hubIntegration && platformPostgres && artifact);
  assert.match(source, /node-version:\s*"24"/u);
  assert.match(source, /pnpm install --frozen-lockfile/u);
  assert.match(commands(gates).join("\n"), /pnpm db:generate/u);
  assert.match(commands(gates).join("\n"), /pnpm contract:verify-generated/u);
  assert.doesNotMatch(commands(gates).join("\n"), /contract:check-product-publication/u);
  assert.match(commands(gates).join("\n"), /pnpm audit --prod/u);
  assert.match(commands(gates).join("\n"), /pnpm lint/u);
  assert.match(commands(gates).join("\n"), /pnpm typecheck/u);
  assert.match(commands(gates).join("\n"), /pnpm test/u);
  assert.equal(commands(hubIntegration).at(-1), "pnpm test:integration");
  assert.match(platformPostgres.services.postgres.image, /^postgres:18\.4@sha256:[a-f0-9]{64}$/u);
  assert.match(commands(platformPostgres).join("\n"), /provision-platform-postgres\.sql/u);
  assert.match(commands(platformPostgres).join("\n"), /pnpm build:runtime/u);
  assert.match(commands(platformPostgres).join("\n"), /pnpm db:migrate/u);
  assert.equal(commands(platformPostgres).at(-1), "pnpm test:component:postgres");
  assert.deepEqual(artifact.needs, ["gates", "hub-integration", "platform-postgres"]);
  assert.doesNotMatch(source, /mysql|DATABASE_URL_(?:SITE|USER|MODEL|CREDIT|PAYMENT|ADMIN)/iu);
  assert.match(source, /mongo:7/u);
  assert.match(source, /minio\/minio/u);
  const packageManifest = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
  assert.equal(packageManifest.scripts["contract:verify-generated"],
    "node scripts/contract/verify-generated-contracts.mjs .");
  assert.equal(packageManifest.scripts.test,
    "pnpm run test:repository && pnpm run test:platform && pnpm run test:unit && " +
    "pnpm run test:security && pnpm -r test");
  assert.equal(packageManifest.scripts["test:unit"], "vitest run test/unit/*.test.ts");
  assert.match(packageManifest.scripts["test:identity"], /test\/unit\/identity-\*\.test\.ts/u);
  assert.match(packageManifest.scripts["test:identity"], /test\/unit\/secret-files\.test\.ts/u);
  assert.match(packageManifest.scripts["test:security"], /test\/security\/\*\.test\.ts/u);
  assert.match(packageManifest.scripts["test:site"], /test\/unit\/site-\*\.test\.ts/u);
});

test("PostgreSQL CI provisions isolated non-superuser roles", async () => {
  const source = await readFile(
    resolve(root, "scripts/ci/provision-platform-postgres.sql"),
    "utf8",
  );
  const roles = [
    "platform_migrator",
    "platform_api",
    "platform_admission",
    "platform_authorization",
    "platform_asset_data_plane",
    "platform_artifact_data_plane",
    "platform_commerce_worker",
    "platform_site_worker",
    "platform_asset_worker",
    "platform_admin_worker",
    "platform_identity_worker",
    "platform_authorization_maintenance",
    "platform_admin",
    "platform_model_gateway",
    "platform_model_image_worker",
    "platform_media_public",
    "platform_media_runtime",
    "platform_media_worker",
    "platform_memory_public",
    "platform_memory_runtime",
    "platform_memory_worker",
  ];
  for (const role of roles) {
    assert.match(source, new RegExp(`CREATE ROLE ${role}\\b`, "u"));
  }
  assert.doesNotMatch(source, /CREATE ROLE platform_worker\b/u);
  assert.equal(
    (source.match(/NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS/gu) ?? []).length,
    roles.length,
  );
  assert.match(source, /CREATE DATABASE kokoro_test_platform OWNER platform_migrator;/u);
  assert.match(source, /REVOKE ALL ON DATABASE kokoro_test_platform FROM PUBLIC;/u);
  assert.doesNotMatch(source, /GRANT\s+ALL/iu);
});

test("artifact is built once from the repository-owned Dockerfile", async () => {
  const source = await readFile(resolve(root, ".github/workflows/ci.yml"), "utf8");
  const jobs = workflowJobs(source);
  const buildCommands = Object.entries(jobs).flatMap(([name, job]) =>
    commands(job).filter((command) => command.includes("docker build")).map((command) => ({ name, command })));
  assert.deepEqual(buildCommands, [{
    name: "artifact",
    command: "docker build --file deploy/docker/Dockerfile --tag kokoro-platform:${{ github.sha }} .",
  }]);
});

test("legacy source trees are deleted rather than excluded from active tooling", async () => {
  const [dockerignore, eslintConfig, workspace, lockfile] = await Promise.all([
    readFile(resolve(root, ".dockerignore"), "utf8"),
    readFile(resolve(root, "eslint.config.mjs"), "utf8"),
    readFile(resolve(root, "pnpm-workspace.yaml"), "utf8").then(parse),
    readFile(resolve(root, "pnpm-lock.yaml"), "utf8").then(parse),
  ]);
  assert.deepEqual(workspace.packages, ["kokoro-platform-kit", "kokoro-hub"]);
  assert.deepEqual(Object.keys(lockfile.importers).sort(), [
    ".", "kokoro-hub", "kokoro-platform-kit",
  ]);
  assert.match(dockerignore, /^\*\*\/dist$/mu);
  assert.match(dockerignore, /^\*\*\/generated\/prisma$/mu);
  for (const directory of legacySourceDirectories) {
    assert.deepEqual(await sourceTreeEntries(directory), [], `${directory} source tree must be deleted`);
    assert.doesNotMatch(dockerignore, new RegExp(`^${directory}$`, "mu"));
    assert.doesNotMatch(eslintConfig, new RegExp(`^[ \\t]*["']${directory}/\\*\\*["'],?$`, "mu"));
  }
});

test("canonical contract trees remain in the clean Docker build context", async () => {
  const dockerignore = await readFile(resolve(root, ".dockerignore"), "utf8");
  assert.doesNotMatch(dockerignore, /^(?:\*\*\/)?generated$/mu);
  assert.match(dockerignore, /^src\/generated\/\*$/mu);
  for (const root of ["contracts", "proto", "schema"]) {
    assert.match(dockerignore, new RegExp(`^!src/generated/${root}(?:/\\*\\*)?$`, "mu"));
  }
  assert.match(dockerignore, /^!src\/generated\/provenance\.json$/mu);
});
