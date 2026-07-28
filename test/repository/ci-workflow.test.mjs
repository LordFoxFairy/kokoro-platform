import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { parse } from "yaml";

const root = resolve(import.meta.dirname, "../..");

function parseWorkflow(workflow) {
  const document = parse(workflow);
  assert.ok(document !== null && typeof document === "object" && !Array.isArray(document));
  const jobs = document.jobs;
  assert.ok(jobs !== null && typeof jobs === "object" && !Array.isArray(jobs));
  return { document, jobs };
}

function requireJob(jobs, jobName) {
  const job = jobs[jobName];
  assert.ok(job !== null && typeof job === "object" && !Array.isArray(job), `${jobName} job is required`);
  assert.ok(Array.isArray(job.steps), `${jobName} steps are required`);
  return job;
}

function assertNoBypass(target, label) {
  assert.equal(Object.hasOwn(target, "if"), false, `${label} must not declare if`);
  assert.equal(
    Object.hasOwn(target, "continue-on-error"),
    false,
    `${label} must not declare continue-on-error`,
  );
}

function allWorkflowSteps(jobs) {
  return Object.entries(jobs).flatMap(([jobName, job]) =>
    job !== null && typeof job === "object" && Array.isArray(job.steps)
      ? job.steps.map((step, index) => ({ jobName, index, step }))
      : [],
  );
}

function assertProductionAuditGate(workflow) {
  const { jobs } = parseWorkflow(workflow);
  const gates = jobs.gates;
  requireJob(jobs, "gates");
  assertNoBypass(gates, "gates job");

  const auditSteps = gates.steps.filter(
    (step) => step !== null && typeof step === "object" && step.name === "production dependency audit",
  );
  assert.equal(auditSteps.length, 1, "gates must contain exactly one named production audit step");
  const audit = auditSteps[0];
  assert.equal(audit.run, "pnpm audit --prod");
  assertNoBypass(audit, "production audit step");
  assert.equal(Object.hasOwn(audit, "shell"), false, "production audit step must not override shell");

  const commandSteps = allWorkflowSteps(jobs).filter(
    ({ step }) =>
      step !== null &&
      typeof step === "object" &&
      typeof step.run === "string" &&
      step.run.includes("pnpm audit --prod"),
  );
  assert.equal(commandSteps.length, 1, "production audit command must be unique across all jobs");
  assert.equal(commandSteps[0].jobName, "gates");
  assert.equal(commandSteps[0].step, audit);
}

function assertArtifactGate(workflow) {
  const { document, jobs } = parseWorkflow(workflow);
  const gates = requireJob(jobs, "gates");
  const artifact = requireJob(jobs, "artifact");
  assertNoBypass(gates, "gates job");
  assertNoBypass(artifact, "artifact job");
  assert.equal(Object.hasOwn(document, "defaults"), false, "workflow defaults are forbidden");
  assert.equal(Object.hasOwn(gates, "defaults"), false, "gates defaults are forbidden");
  assert.equal(Object.hasOwn(artifact, "defaults"), false, "artifact defaults are forbidden");
  assert.deepEqual(artifact.needs, ["gates", "integration"]);
  assert.equal(artifact.steps.length, 2, "artifact job must contain checkout followed by one build step");
  assert.deepEqual(artifact.steps[0], { uses: "actions/checkout@v4" });

  const build = artifact.steps[1];
  assert.ok(build !== null && typeof build === "object" && !Array.isArray(build));
  assert.equal(build.name, "build deployment image");
  assert.equal(
    build.run,
    "docker build --file deploy/docker/Dockerfile --tag kokoro-platform:${{ github.sha }} .",
  );
  assertNoBypass(build, "artifact build step");
  assert.equal(Object.hasOwn(build, "shell"), false, "artifact build step must not override shell");
  assert.equal(Object.hasOwn(build, "defaults"), false, "artifact build step must not declare defaults");

  const buildCommands = allWorkflowSteps(jobs).filter(
    ({ step }) =>
      step !== null &&
      typeof step === "object" &&
      typeof step.run === "string" &&
      step.run.includes("docker build"),
  );
  assert.equal(buildCommands.length, 1, "deployment image build command must be unique across all jobs");
  assert.equal(buildCommands[0].jobName, "artifact");
  assert.equal(buildCommands[0].index, 1);
  assert.equal(buildCommands[0].step, build);
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

test("the production audit contract rejects skipped, swallowed, and misplaced gates", async () => {
  const workflow = await readFile(resolve(root, ".github/workflows/ci.yml"), "utf8");
  const auditBlock = "      - name: production dependency audit\n        run: pnpm audit --prod\n";
  const invalidWorkflows = [
    workflow.replace("run: pnpm audit --prod", "run: pnpm audit --prod || true"),
    workflow.replace(auditBlock, "      - name: production dependency audit\n        continue-on-error: true\n        run: pnpm audit --prod\n"),
    workflow.replace(auditBlock, "      - name: production dependency audit\n        if: always()\n        run: pnpm audit --prod\n"),
    workflow.replace(auditBlock, `${auditBlock}      - name: duplicate production audit\n        run: pnpm audit --prod\n`),
    workflow.replace(auditBlock, "      # run: pnpm audit --prod\n"),
    workflow
      .replace(auditBlock, "")
      .replace(
        "  artifact:\n",
        `  audit-copy:\n    runs-on: ubuntu-latest\n    steps:\n${auditBlock}\n  artifact:\n`,
      ),
  ];

  for (const invalid of invalidWorkflows) {
    assert.notEqual(invalid, workflow, "mutation fixture must alter the workflow");
    assert.doesNotThrow(() => parse(invalid), "mutation fixture must remain valid YAML");
    assert.throws(() => assertProductionAuditGate(invalid));
  }
});

test("protected CI jobs reject job-level bypasses", async () => {
  const workflow = await readFile(resolve(root, ".github/workflows/ci.yml"), "utf8");
  const invalidWorkflows = [
    workflow.replace("  gates:\n", "  gates:\n    if: always()\n"),
    workflow.replace("  gates:\n", "  gates:\n    continue-on-error: true\n"),
    workflow.replace("  artifact:\n", "  artifact:\n    if: always()\n"),
    workflow.replace("  artifact:\n", "  artifact:\n    continue-on-error: true\n"),
  ];

  for (const invalid of invalidWorkflows) {
    assert.throws(() => {
      assertProductionAuditGate(invalid);
      assertArtifactGate(invalid);
    });
  }
});

test("the artifact contract rejects bypass, defaults, duplicate, comment, and placement mutations", async () => {
  const workflow = await readFile(resolve(root, ".github/workflows/ci.yml"), "utf8");
  const command =
    "          docker build --file deploy/docker/Dockerfile\n          --tag kokoro-platform:${{ github.sha }} .";
  const invalidWorkflows = [
    workflow.replace("${{ github.sha }} .", "${{ github.sha }} . || true"),
    workflow.replace("      - name: build deployment image\n", "      - name: build deployment image\n        continue-on-error: true\n"),
    workflow.replace("      - name: build deployment image\n", "      - name: build deployment image\n        if: always()\n"),
    workflow.replace("      - name: build deployment image\n", "      - name: build deployment image\n        shell: bash\n"),
    workflow.replace("      - name: build deployment image\n", "      - name: build deployment image\n        defaults: {}\n"),
    workflow.replace("    steps:\n      - uses: actions/checkout@v4\n      - name: build deployment image", "    defaults:\n      run:\n        shell: bash\n    steps:\n      - uses: actions/checkout@v4\n      - name: build deployment image"),
    workflow.replace("jobs:\n", "defaults:\n  run:\n    shell: bash\n\njobs:\n"),
    workflow.replace(command, `${command}\n      - name: duplicate image\n        run: docker build --file deploy/docker/Dockerfile --tag kokoro-platform:duplicate .`),
    workflow.replace(
      "      - name: build deployment image\n        run: >-\n" + command,
      "      # run: docker build --file deploy/docker/Dockerfile --tag kokoro-platform:${{ github.sha }} .\n      - name: build deployment image\n        run: echo disabled",
    ),
    workflow.replace("      - name: build deployment image\n", "      - run: echo prebuild\n      - name: build deployment image\n"),
    workflow
      .replace("      - name: build deployment image\n        run: >-\n" + command, "      - name: build deployment image\n        run: echo misplaced")
      .replace(
        "  artifact:\n",
        "  gates-copy:\n    runs-on: ubuntu-latest\n    steps:\n      - run: docker build --file deploy/docker/Dockerfile --tag kokoro-platform:${{ github.sha }} .\n\n  artifact:\n",
      ),
  ];

  for (const invalid of invalidWorkflows) {
    assert.notEqual(invalid, workflow, "mutation fixture must alter the workflow");
    assert.doesNotThrow(() => parse(invalid), "mutation fixture must remain valid YAML");
    assert.throws(() => assertArtifactGate(invalid));
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

  assertArtifactGate(workflow);
  assert.match(
    dockerignore,
    /!kokoro-platform-admin\/src\/generated\n!kokoro-platform-admin\/src\/generated\/contracts\n!kokoro-platform-admin\/src\/generated\/contracts\/\*\*/u,
  );
});
