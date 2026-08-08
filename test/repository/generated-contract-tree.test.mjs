import assert from "node:assert/strict";
import { access, readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const root = resolve(import.meta.dirname, "../..");
const canonicalRoots = Object.freeze([
  "src/generated/contracts",
  "src/generated/proto",
  "src/generated/schema",
]);
const canonicalRuntimeMirrors = Object.freeze([
  "src/generated/contracts/runtime/platform-control.ts",
]);
const retiredRuntimeMirrors = Object.freeze([
  "src/generated/contracts/runtime/hub-storage.ts",
  "src/generated/contracts/runtime/platform-runtime.ts",
]);
const retiredRuntimeMirrorRoot = ["src", "generated", "contracts", "legacy"].join("/");
const legacyRoots = Object.freeze([
  retiredRuntimeMirrorRoot,
  "kokoro-hub/src/interfaces/connect/generated-capability-catalog",
  "src/interfaces/connect/generated",
  "src/interfaces/connect/generated-admin-commerce",
  "src/interfaces/connect/generated-admin-credit",
  "src/interfaces/connect/generated-admin-identity",
  "src/interfaces/connect/generated-admin-query-v2",
  "src/interfaces/connect/generated-admin-v2",
  "src/interfaces/connect/generated-agent-evidence",
  "src/interfaces/connect/generated-asset-eligibility",
  "src/interfaces/connect/generated-authorization",
  "src/interfaces/connect/generated-authorization-v2",
  "src/interfaces/connect/generated-capability-catalog",
  "src/interfaces/connect/generated-commerce",
  "src/interfaces/connect/generated-media-runtime",
  "src/interfaces/connect/generated-model-control",
  "src/interfaces/connect/generated-model-gateway",
  "src/interfaces/connect/generated-model-image-effect",
  "src/interfaces/connect/generated-product-catalog-publication",
  "src/interfaces/connect/generated-session-admission-owner",
  "src/interfaces/connect/generated-session-evidence",
  "src/interfaces/connect/generated-session-media-projection",
  "src/interfaces/connect/generated-site-evidence-admission",
  "src/interfaces/connect/generated-site-lifecycle",
  "src/interfaces/connect/generated-site-provisioning",
  "src/interfaces/connect/generated-site-publication",
  "src/interfaces/http/generated",
  "src/interfaces/json-schema/generated-product-catalog",
  "src/interfaces/json-schema/generated-site-publication",
]);
const retiredAuthorizationV1Sources = Object.freeze([
  "src/interfaces/connect/session-authorization.ts",
  "src/modules/authorization/application/services/publish-session-authorization.ts",
  "src/modules/authorization/infrastructure/postgres/authorization-feed-repository.ts",
  "src/modules/authorization/infrastructure/postgres/signed-session-authorization-publisher.ts",
]);
const retiredPackageContractMirrors = Object.freeze([
  "contract/vendor/product-catalog-publication",
  "kokoro-hub/src/contract/storage.ts",
  "kokoro-platform-kit/src/contract/control.ts",
  "kokoro-platform-kit/src/contract/platform-runtime.ts",
  "scripts/contract/generate-product-publication-schemas.mjs",
]);
const retiredHubConnectRuntimeSources = Object.freeze([
  "kokoro-hub/src/infrastructure/connect/platform-capability-projection-client.ts",
  "kokoro-hub/src/interfaces/connect/capability-catalog-services.ts",
  "kokoro-hub/src/interfaces/connect/hub-connect-runtime.ts",
  "kokoro-hub/src/interfaces/connect/main.ts",
]);
const hubOwnerLocalStorageContracts = Object.freeze([
  "kokoro-hub/src/contract/mcp-secret-storage.ts",
  "kokoro-hub/src/contract/mcp-storage.ts",
  "kokoro-hub/src/contract/skill-curation-storage.ts",
]);

async function exists(path) {
  return access(resolve(root, path)).then(() => true, () => false);
}

async function sourceFiles(directory) {
  const absolute = resolve(root, directory);
  if (!(await exists(directory))) return [];
  const entries = await readdir(absolute, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const relative = `${directory}/${entry.name}`;
    if (entry.isDirectory()) return sourceFiles(relative);
    return /\.(?:[cm]?[jt]s|tsx)$/u.test(entry.name) ? [relative] : [];
  }));
  return nested.flat();
}

test("generated contracts have one canonical checked-in tree", async () => {
  for (const canonicalRoot of canonicalRoots) {
    assert.equal(await exists(canonicalRoot), true, `${canonicalRoot} must exist`);
    const ignored = spawnSync("git", ["check-ignore", "--quiet", canonicalRoot], {
      cwd: root,
    });
    assert.equal(ignored.status, 1, `${canonicalRoot} must be tracked rather than ignored`);
  }
  for (const mirror of canonicalRuntimeMirrors) {
    assert.equal(await exists(mirror), true, `${mirror} must be generated and tracked`);
  }
  for (const mirror of retiredRuntimeMirrors) {
    assert.equal(await exists(mirror), false, `${mirror} must be deleted`);
  }
  assert.equal(await exists("src/generated/provenance.json"), true);
  assert.equal(
    spawnSync("git", ["check-ignore", "--quiet", "src/generated/provenance.json"], { cwd: root }).status,
    1,
    "generated provenance must be tracked",
  );
  assert.equal(
    spawnSync("git", ["check-ignore", "--quiet", "src/generated/platform-prisma/client.ts"], {
      cwd: root,
    }).status,
    0,
    "Prisma client remains build-local rather than a Root contract artifact",
  );

  for (const legacyRoot of legacyRoots) {
    assert.equal(await exists(legacyRoot), false, `${legacyRoot} must be deleted`);
  }
  for (const source of retiredAuthorizationV1Sources) {
    assert.equal(await exists(source), false, `${source} must be deleted`);
  }
  for (const source of retiredPackageContractMirrors) {
    assert.equal(await exists(source), false, `${source} must be deleted`);
  }
  for (const source of retiredHubConnectRuntimeSources) {
    assert.equal(await exists(source), false, `${source} must be moved to Platform`);
  }
  for (const source of hubOwnerLocalStorageContracts) {
    assert.equal(await exists(source), true, `${source} remains owned by Hub`);
  }
  assert.equal(await exists("src/process/hub-connect.ts"), true);
  assert.doesNotMatch(
    await readFile(resolve(
      root,
      "src/modules/authorization/application/contracts/session-authorization-ports.ts",
    ), "utf8"),
    /SessionAuthorizationPublisher/u,
  );
  const manifest = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
  assert.equal(Object.hasOwn(manifest.scripts, "contract:generate-product-publication"), false);
  assert.equal(Object.hasOwn(manifest.scripts, "contract:check-product-publication"), false);
  const hubManifest = JSON.parse(await readFile(resolve(root, "kokoro-hub/package.json"), "utf8"));
  assert.equal(Object.hasOwn(hubManifest.scripts, "dev:connect"), false);
  assert.equal(Object.hasOwn(hubManifest.scripts, "start:connect"), false);
});

test("active code imports generated contracts only from the canonical tree", async () => {
  const files = (await Promise.all([
    "src",
    "test",
    "scripts",
    "kokoro-hub/src",
    "kokoro-hub/test",
    "kokoro-platform-kit/src",
    "kokoro-platform-kit/test",
  ].map(sourceFiles))).flat();
  const violations = [];
  for (const file of files) {
    if (file === "test/repository/generated-contract-tree.test.mjs") continue;
    const source = await readFile(resolve(root, file), "utf8");
    const specifiers = [...source.matchAll(
      /(?:from\s+|import\s*\()(["'])(?<specifier>[^"']+)\1/gu,
    )].map((match) => match.groups?.specifier ?? "");
    if (specifiers.some((specifier) =>
      specifier.includes(retiredRuntimeMirrorRoot.slice("src/".length)) ||
      /(?:interfaces\/(?:connect|http|json-schema)\/generated|generated-(?:admin|agent|asset|authorization|capability|commerce|media|model|product|session|site)|credit_catalog_pb)/u.test(specifier)
    )) violations.push(file);
  }
  assert.deepEqual(violations, []);
});

test("production evidence uses v1 while dormant v2 remains contract-only", async () => {
  const client = await readFile(
    resolve(root, "src/interfaces/connect/agent-execution-evidence-client.ts"),
    "utf8",
  );
  assert.match(client, /generated\/proto\/kokoro\/agent\/execution\/v1/u);
  assert.doesNotMatch(client, /generated\/proto\/kokoro\/agent\/execution\/v2/u);
  for (const version of ["v1", "v2"]) {
    assert.equal(await exists(
      `src/generated/proto/kokoro/agent/execution/${version}/agent_execution_evidence_pb.ts`,
    ), true);
  }
  assert.equal(await exists(
    "src/generated/proto/kokoro/platform/credit/v1/credit_catalog_pb.ts",
  ), false);
});
