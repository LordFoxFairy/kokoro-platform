import { chmod, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CORE_SINGLE_SITE_SURFACES,
  coreBootstrapConfigDigest,
  coreBootstrapIdempotencyKey,
  coreBootstrapUuid,
  loadCoreSingleSiteBootstrapDocument,
} from "../../src/process/core-single-site-bootstrap-document.js";

const sha = (value: string) => value.repeat(64).slice(0, 64);
const uuid = (tail: string) => `00000000-0000-7000-8000-${tail.padStart(12, "0")}`;

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "kokoro-core-bootstrap-document-"));
  const passwordFile = join(directory, "password");
  const entropyKeyFile = join(directory, "entropy-key");
  await writeFile(passwordFile, "correct horse battery staple", { mode: 0o600 });
  await writeFile(entropyKeyFile, "e".repeat(32), { mode: 0o600 });
  const document = {
    version: 1,
    bootstrapId: uuid("1"),
    environment: "production",
    region: "us-east-1",
    makerSubjectRef: "operator:core-maker",
    checkerSubjectRef: "operator:core-checker",
    site: {
      siteId: "site:core",
      siteKey: "core",
      siteReleaseRef: "site-release:core:1",
      siteProjectBindingRef: "site-binding:core:1",
      workloadIdentityId: "spiffe://kokoro/site/core",
      workloadBindingEpoch: "1",
      providerNamespace: "core.fixed",
      providerProjectRef: "core-site",
      metadataEndpoint: "https://core-site.internal/.well-known/kokoro-release",
      webArtifactDigest: sha("a"),
      releaseManifestDigest: sha("b"),
      certificationDigest: sha("c"),
      releaseCertification: { signingKeyRef: "site-release-key:core",
        issuedAt: "2026-08-11T00:00:00.000Z", expiresAt: "2026-08-12T00:00:00.000Z",
        signature: "A".repeat(86) },
      signedContractFloor: { ref: "contract-floor:core", revision: "1", digest: sha("d") },
      audience: "site-product",
      sessionContractRevision: "session-browser-v3",
    },
    model: {
      provider: "direct",
      providerKey: "direct-primary",
      modelKey: "chat-primary",
      modelOptionKey: "chat-primary",
      endpoint: "https://direct-model.internal/v1",
      inventoryRef: "model-inventory:core",
      inventoryRevision: "1",
      optionRevisionRef: "model-option:core:1",
      catalogRef: "model-catalog:core:1",
    },
    rating: { policyRevisionRef: "rating-policy:core:1", unit: "credit", inputTokenAmount: "1", outputTokenAmount: "1" },
    redemption: {
      creditProgramRevisionRef: "credit-program:core:1",
      productVersionRef: "product:core-credit:1",
      fulfillmentProgramRevisionRef: "fulfillment:core-credit:1",
      programRevisionRef: "redemption-program:core:1",
      batchRef: uuid("2"),
      amount: "250000",
      liabilityMerchantAccountRef: "merchant:core",
      entropyKeyFile,
    },
    identity: {
      email: "owner@example.test",
      passwordFile,
      accountRef: uuid("3"),
      subjectRef: "subject:core-owner",
      workspaceRef: "workspace:core-owner",
      projectRef: "project:core-owner",
      billingAccountRef: "billing:core-owner",
      executionSpaceRef: "execution-space:core-owner",
      executionNamespace: "namespace_core_owner",
    },
    externalEmptyAgentCatalogRef: `agent-catalog:sha256:${sha("f")}`,
  };
  const path = join(directory, "bootstrap.json");
  await writeFile(path, JSON.stringify(document), { mode: 0o600 });
  return { directory, document, path, passwordFile, entropyKeyFile };
}

describe("core single-Site bootstrap document", () => {
  it("loads one exact Direct-only document and keeps launch surfaces code-owned", async () => {
    const { path } = await fixture();
    const loaded = await loadCoreSingleSiteBootstrapDocument(path, { KOKORO_ENVIRONMENT: "production" });
    expect(loaded.model.provider).toBe("direct");
    expect(CORE_SINGLE_SITE_SURFACES).toEqual(["account", "chat", "redemption"]);
    expect(Object.hasOwn(loaded, "surfaces")).toBe(false);
  });

  it("accepts Compose-internal HTTP metadata but rejects external plaintext HTTP", async () => {
    const item = await fixture();
    item.document.site.metadataEndpoint = "http://kokoro-site-release.internal:3000/api/release/metadata";
    await writeFile(item.path, JSON.stringify(item.document), { mode: 0o600 });
    await expect(loadCoreSingleSiteBootstrapDocument(item.path, { KOKORO_ENVIRONMENT: "production" }))
      .resolves.toMatchObject({ site: { metadataEndpoint: item.document.site.metadataEndpoint } });
    item.document.site.metadataEndpoint = "http://example.com/api/release/metadata";
    await writeFile(item.path, JSON.stringify(item.document), { mode: 0o600 });
    await expect(loadCoreSingleSiteBootstrapDocument(item.path, { KOKORO_ENVIRONMENT: "production" }))
      .rejects.toThrow("CORE_SINGLE_SITE_BOOTSTRAP_DOCUMENT_INVALID");
  });

  it.each<readonly [string, (value: Awaited<ReturnType<typeof fixture>>["document"]) => void]>([
    ["unknown top-level key", (value) => { Object.assign(value, { payment: {} }); }],
    ["same maker and checker", (value) => { value.checkerSubjectRef = value.makerSubjectRef; }],
    ["non-Direct provider", (value) => { value.model.provider = "litellm"; }],
    ["feature-off nested key", (value) => { Object.assign(value.site, { memory: true }); }],
    ["unsafe model endpoint", (value) => { value.model.endpoint = "http://127.0.0.1:4000"; }],
    ["malformed batch ref", (value) => { value.redemption.batchRef = "batch:one"; }],
    ["invalid release certification", (value) => { value.site.releaseCertification.signature = "short"; }],
  ])("rejects %s", async (_name, mutate) => {
    const item = await fixture();
    mutate(item.document);
    await writeFile(item.path, JSON.stringify(item.document), { mode: 0o600 });
    await expect(loadCoreSingleSiteBootstrapDocument(item.path, { KOKORO_ENVIRONMENT: "production" }))
      .rejects.toThrow("CORE_SINGLE_SITE_BOOTSTRAP_DOCUMENT_INVALID");
  });

  it("rejects relative, symlink, non-0600 and oversized documents", async () => {
    const item = await fixture();
    await expect(loadCoreSingleSiteBootstrapDocument("relative.json", {}))
      .rejects.toThrow("CORE_SINGLE_SITE_BOOTSTRAP_FILE_INVALID");
    const link = join(item.directory, "link.json");
    await symlink(item.path, link);
    await expect(loadCoreSingleSiteBootstrapDocument(link, {}))
      .rejects.toThrow("CORE_SINGLE_SITE_BOOTSTRAP_FILE_INVALID");
    await chmod(item.path, 0o640);
    await expect(loadCoreSingleSiteBootstrapDocument(item.path, {}))
      .rejects.toThrow("CORE_SINGLE_SITE_BOOTSTRAP_FILE_PERMISSIONS_INVALID");
    await chmod(item.path, 0o600);
    await writeFile(item.path, "x".repeat(256 * 1024 + 1), { mode: 0o600 });
    await expect(loadCoreSingleSiteBootstrapDocument(item.path, {}))
      .rejects.toThrow("CORE_SINGLE_SITE_BOOTSTRAP_FILE_INVALID");
  });

  it("rejects relative password/code entropy paths and environment mismatch", async () => {
    const item = await fixture();
    item.document.identity.passwordFile = "password";
    await writeFile(item.path, JSON.stringify(item.document), { mode: 0o600 });
    await expect(loadCoreSingleSiteBootstrapDocument(item.path, { KOKORO_ENVIRONMENT: "production" }))
      .rejects.toThrow("CORE_SINGLE_SITE_BOOTSTRAP_DOCUMENT_INVALID");
    item.document.identity.passwordFile = item.passwordFile;
    await writeFile(item.path, JSON.stringify(item.document), { mode: 0o600 });
    await expect(loadCoreSingleSiteBootstrapDocument(item.path, { KOKORO_ENVIRONMENT: "staging" }))
      .rejects.toThrow("CORE_SINGLE_SITE_BOOTSTRAP_ENVIRONMENT_MISMATCH");
  });

  it("binds canonical config to secret digests without exposing password text", async () => {
    const item = await fixture();
    const loaded = await loadCoreSingleSiteBootstrapDocument(item.path, { KOKORO_ENVIRONMENT: "production" });
    const first = coreBootstrapConfigDigest(loaded, { password: sha("1"), redemptionEntropy: sha("2") });
    const replay = coreBootstrapConfigDigest(loaded, { redemptionEntropy: sha("2"), password: sha("1") });
    expect(first).toBe(replay);
    expect(first).toMatch(/^[a-f0-9]{64}$/u);
    expect(first).not.toContain("correct horse");
    expect(coreBootstrapConfigDigest(loaded, { password: sha("3"), redemptionEntropy: sha("2") }))
      .not.toBe(first);
  });

  it("derives stable domain-separated UUIDs and idempotency keys", () => {
    const bootstrapId = uuid("9");
    const one = coreBootstrapUuid(bootstrapId, "identity.bootstrap");
    expect(one).toBe("33a8ebd9-db7c-4989-8ceb-1ca4daee4741");
    expect(one).toBe(coreBootstrapUuid(bootstrapId, "identity.bootstrap"));
    expect(one).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u);
    expect(one).not.toBe(coreBootstrapUuid(bootstrapId, "commerce.batch"));
    expect(coreBootstrapIdempotencyKey(bootstrapId, "identity.bootstrap"))
      .toBe(`core-bootstrap:${bootstrapId}:identity.bootstrap`);
  });
});
