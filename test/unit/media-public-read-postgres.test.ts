import { describe, expect, it } from "vitest";
import { issuePlatformTransaction, revokePlatformTransaction } from
  "../../src/shared/unit-of-work/platform-transaction.js";
import { PostgresMediaPublicReadRepository } from
  "../../src/modules/media/infrastructure/postgres/media-public-read-repository.js";
import type { ResolvedMediaPublicOwnerAuthority } from
  "../../src/modules/media/application/contracts/media-public-read-ports.js";

const authority: ResolvedMediaPublicOwnerAuthority = Object.freeze({
  siteRef: "site-1", siteReleaseRef: "release-1", siteProjectBindingRef: "binding-1",
  deploymentRef: "deployment-1", workloadIdentityRef: "spiffe://kokoro.test/site-1/web",
  workloadBindingEpoch: 2n, siteSecurityEpoch: 3n, policyEpoch: 4n,
  environment: "production", region: "us-east-1", audience: "platform-public",
  subjectRef: "subject-1", subjectGeneration: 5n, identitySessionRef: "session-1",
  identitySessionEpoch: 6n, restrictionEpoch: 7n, credentialEpoch: 8n,
  projectRef: "project-1", membershipEpoch: 9n, authorizationEpoch: 10n,
  modelOptionCatalogRef: `site-release-model-catalog:sha256:${"a".repeat(64)}`,
});

describe("PostgresMediaPublicReadRepository", () => {
  it("revalidates the complete workload, session and project owner authority", async () => {
    const statements: string[] = [];
    const lease = issuePlatformTransaction({
      query: async <Row extends Record<string, unknown>>(statement: string): Promise<readonly Row[]> => {
        statements.push(statement);
        return [{ membershipEpoch: 9n, authorizationEpoch: 10n,
          modelOptionCatalogRef: authority.modelOptionCatalogRef }] as unknown as readonly Row[];
      },
      execute: async () => 0,
    });
    try {
      const result = await new PostgresMediaPublicReadRepository().resolveOwnerAuthority(lease.transaction, {
        assertion: authority, now: "2026-07-31T12:00:00.000Z",
      });
      expect(result).toEqual(authority);
      expect(statements[0]).toContain("authorization_product_binding");
      expect(statements[0]).toContain("authorization_identity_session");
      expect(statements[0]).toContain("authorization_project_membership");
      expect(statements[0]).toContain("membership.membership_epoch");
      expect(statements[0]).toContain("FOR SHARE OF binding,site,release,identity_session,subject,project,membership");
    } finally { revokePlatformTransaction(lease); }
  });

  it("returns an empty final option page only after confirming the release definition still exists", async () => {
    const rows = [[], [{
      definitionKey: "image.text_to_image@v1",
      definitionRevisionRef: "image.text_to_image@v1:revision:1",
      mediaKind: "image_text_to_image", maximumCandidateCount: 4,
      promptMaximumUtf8Bytes: 32768, supportedAspectRatios: ["square_1_1"],
      supportedOutputFormats: ["png"], publishedAt: "2026-07-31T00:00:00.000Z",
      modelOptionCatalogRevisionRef: "surface-model-catalog:image:sha256:catalog",
    }]];
    const lease = issuePlatformTransaction({
      query: async <Row extends Record<string, unknown>>(): Promise<readonly Row[]> =>
        (rows.shift() ?? []) as unknown as readonly Row[],
      execute: async () => 0,
    });
    try {
      await expect(new PostgresMediaPublicReadRepository().listModelOptions(lease.transaction, {
        authority, definitionRef: "image.text_to_image@v1", positionAfter: 3,
        modelOptionRevisionRefAfter: `model-option:sha256:${"b".repeat(64)}`, limit: 51,
      })).resolves.toEqual({
        definitionRevisionRef: "image.text_to_image@v1:revision:1", options: [],
      });
    } finally { revokePlatformTransaction(lease); }
  });

  it("parses only exact release definition and public model option records", async () => {
    const rows = [[{
      definitionKey: "image.text_to_image@v1", definitionRevisionRef: "image.text_to_image@v1:revision:1",
      mediaKind: "image_text_to_image", maximumCandidateCount: 4, promptMaximumUtf8Bytes: 32768,
      supportedAspectRatios: ["square_1_1"], supportedOutputFormats: ["png"],
      publishedAt: "2026-07-31T00:00:00.000Z",
      modelOptionCatalogRevisionRef: "surface-model-catalog:image:sha256:catalog",
    }], [{ definitionRevisionRef: "image.text_to_image@v1:revision:1", position: 0,
      modelOptionRevisionRef: `model-option:sha256:${"b".repeat(64)}`,
      optionKey: "image.standard", label: "Standard image", description: null,
      inputModalities: ["text"], outputModalities: ["image"], supportedEfforts: [], badges: ["default"],
      availability: "available" }]];
    const lease = issuePlatformTransaction({
      query: async <Row extends Record<string, unknown>>(): Promise<readonly Row[]> =>
        (rows.shift() ?? []) as unknown as readonly Row[],
      execute: async () => 0,
    });
    const repository = new PostgresMediaPublicReadRepository();
    try {
      const definitions = await repository.listDefinitions(lease.transaction, { authority,
        publishedBefore: null, definitionRevisionRefBefore: null, limit: 51 });
      const options = await repository.listModelOptions(lease.transaction, { authority,
        definitionRef: "image.text_to_image@v1", positionAfter: null,
        modelOptionRevisionRefAfter: null, limit: 51 });
      expect(definitions[0]?.maximumCandidateCount).toBe(4);
      expect(options?.options[0]).toMatchObject({ availability: "available", description: null });
    } finally { revokePlatformTransaction(lease); }
  });

  it("rejects corrupt operation rows rather than leaking a partial projection", async () => {
    const lease = issuePlatformTransaction({
      query: async <Row extends Record<string, unknown>>(): Promise<readonly Row[]> =>
        [{ operationRef: "media-operation:one", unexpected: "provider-secret" }] as unknown as readonly Row[],
      execute: async () => 0,
    });
    try {
      await expect(new PostgresMediaPublicReadRepository().listOperations(lease.transaction, { authority,
        createdBefore: null, operationRefBefore: null, limit: 51 }))
        .rejects.toThrow("MEDIA_PUBLIC_OPERATION_RECORD_CORRUPT");
    } finally { revokePlatformTransaction(lease); }
  });
});
