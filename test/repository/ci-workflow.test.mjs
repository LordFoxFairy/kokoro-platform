import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { parse } from "yaml";

const root = resolve(import.meta.dirname, "../..");

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
  assert.match(packageManifest.scripts.test, /test:identity/u);
  assert.match(packageManifest.scripts.test, /test:security/u);
  assert.match(packageManifest.scripts["test:identity"], /test\/unit\/identity-\*\.test\.ts/u);
  assert.match(packageManifest.scripts["test:identity"], /test\/unit\/secret-files\.test\.ts/u);
  assert.match(packageManifest.scripts["test:security"], /test\/security\/\*\.test\.ts/u);
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
    "platform_commerce_worker",
    "platform_site_worker",
    "platform_asset_worker",
    "platform_admin_worker",
    "platform_identity_worker",
    "platform_authorization_maintenance",
    "platform_admin",
    "platform_model_gateway",
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

test("legacy source directories are excluded from Docker build context", async () => {
  const dockerignore = await readFile(resolve(root, ".dockerignore"), "utf8");
  for (const directory of [
    "kokoro-platform-admin", "kokoro-site", "kokoro-user", "kokoro-model",
    "kokoro-credit", "kokoro-payment",
  ]) assert.match(dockerignore, new RegExp(`^${directory}$`, "mu"));
});

test("runtime contract mirrors remain in the clean Docker build context", async () => {
  const dockerignore = await readFile(resolve(root, ".dockerignore"), "utf8");
  assert.doesNotMatch(dockerignore, /^(?:\*\*\/)?generated$/mu);
  assert.match(dockerignore, /^src\/generated$/mu);
});
