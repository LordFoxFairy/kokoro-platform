import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { parse } from "yaml";

const root = resolve(import.meta.dirname, "../..");

function assertProductionAuditGate(workflow) {
  const document = parse(workflow);
  assert.ok(document !== null && typeof document === "object" && !Array.isArray(document));
  const jobs = document.jobs;
  assert.ok(jobs !== null && typeof jobs === "object" && !Array.isArray(jobs));
  const gates = jobs.gates;
  assert.ok(gates !== null && typeof gates === "object" && !Array.isArray(gates));
  assert.ok(Array.isArray(gates.steps));

  const auditSteps = gates.steps.filter(
    (step) => step !== null && typeof step === "object" && step.name === "production dependency audit",
  );
  assert.equal(auditSteps.length, 1, "gates must contain exactly one named production audit step");
  const audit = auditSteps[0];
  assert.equal(audit.run, "pnpm audit --prod");
  assert.equal(Object.hasOwn(audit, "continue-on-error"), false);
  assert.equal(Object.hasOwn(audit, "if"), false);

  for (const [jobName, job] of Object.entries(jobs)) {
    if (jobName === "gates" || job === null || typeof job !== "object" || !Array.isArray(job.steps)) continue;
    assert.equal(
      job.steps.some(
        (step) => step !== null && typeof step === "object" && typeof step.run === "string" && step.run.includes("pnpm audit --prod"),
      ),
      false,
      `production audit must not be moved to ${jobName}`,
    );
  }
}

test("platform CI is lock-driven and separates local from integration gates", async () => {
  const workflow = await readFile(resolve(root, ".github/workflows/ci.yml"), "utf8");
  const packageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));

  assert.equal(packageJson.packageManager, "pnpm@11.2.2");
  assert.match(workflow, /node-version:\s*["']?22["']?/u);
  assert.match(workflow, /corepack enable/u);
  assert.match(workflow, /pnpm install --frozen-lockfile/u);
  assertProductionAuditGate(workflow);
  assert.match(workflow, /pnpm lint/u);
  assert.match(workflow, /pnpm typecheck/u);
  assert.match(workflow, /pnpm test/u);
  assert.match(workflow, /^\s{2}integration:/mu);
  assert.match(workflow, /pnpm test:integration/u);
  assert.match(workflow, /mysql:/u);
  assert.match(workflow, /mongo:/u);
  assert.match(workflow, /redis:/u);
  assert.match(workflow, /minio:/u);
});

test("the production audit contract rejects skipped, swallowed, and misplaced gates", () => {
  const invalidWorkflows = [
    `jobs:\n  gates:\n    steps:\n      - run: pnpm audit --prod || true\n`,
    `jobs:\n  gates:\n    steps:\n      - run: pnpm audit --prod\n        continue-on-error: true\n`,
    `jobs:\n  gates:\n    steps:\n      - run: pnpm test\n  integration:\n    steps:\n      - run: pnpm audit --prod\n`,
    `jobs:\n  gates:\n    steps:\n      # run: pnpm audit --prod\n      - run: pnpm test\n`,
  ];

  for (const workflow of invalidWorkflows) {
    assert.throws(() => assertProductionAuditGate(workflow));
  }
});

test("the root test gate executes repository governance checks", async () => {
  const packageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));

  assert.equal(packageJson.scripts["test:repository"], "node --test test/repository/*.test.mjs");
  assert.match(packageJson.scripts.test, /pnpm run test:repository/u);
});

test("platform CI builds the repository-owned deployment artifact", async () => {
  const workflow = await readFile(resolve(root, ".github/workflows/ci.yml"), "utf8");
  const dockerignore = await readFile(resolve(root, ".dockerignore"), "utf8");

  assert.match(workflow, /^\s{2}artifact:/mu);
  assert.match(workflow, /needs:\s*\[gates, integration\]/u);
  assert.match(workflow, /docker build/u);
  assert.match(workflow, /--file deploy\/docker\/Dockerfile/u);
  assert.match(workflow, /--tag kokoro-platform:\$\{\{ github\.sha \}\}/u);
  assert.match(
    dockerignore,
    /!kokoro-platform-admin\/src\/generated\n!kokoro-platform-admin\/src\/generated\/contracts\n!kokoro-platform-admin\/src\/generated\/contracts\/\*\*/u,
  );
});
