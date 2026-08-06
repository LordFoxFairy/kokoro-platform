import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ProductCatalogPublicationService } from
  "../../src/modules/product-catalog/application/services/product-catalog-publication-service.js";
import type { ProductCatalogPublicationJournal } from
  "../../src/modules/product-catalog/application/contracts/product-catalog-publication-journal.js";
import type { ProductCatalogPublicationRepository } from
  "../../src/modules/product-catalog/application/contracts/product-catalog-publication-repository.js";
import { createProductPublicationCommand } from
  "../../src/modules/product-catalog/application/product-publication-command.js";
import { PostgresProductCatalogPublicationJournal } from
  "../../src/modules/product-catalog/infrastructure/postgres/product-catalog-publication-journal.js";
import { PostgresProductCatalogPublicationRepository } from
  "../../src/modules/product-catalog/infrastructure/postgres/product-catalog-publication-repository.js";
import {
  canonicalDigest,
  canonicalJson,
  verifyCanonicalDocument,
} from "../../src/modules/product-catalog/domain/canonical-product-document.js";
import {
  decideCatalogPublication,
  resolveLaunchProductProfileRevision,
  resolveProductSurfaceCatalogRevision,
  validateLaunchProductProfileClosure,
} from "../../src/modules/product-catalog/domain/product-publication.js";
import {
  PlatformUnitOfWork,
  type PlatformTransactionHost,
} from "../../src/shared/unit-of-work/index.js";
import { issuePlatformTransaction, revokePlatformTransaction } from
  "../../src/shared/unit-of-work/platform-transaction.js";
import { verifyRequestSecurityContext } from
  "../../src/shared/security-context/request-security-context.js";

describe("Product Catalog publication authority", () => {
  it("validates generated Root shapes and product/surface/journey closure", () => {
    const catalog = catalogDocument();
    const catalogSource = source(catalog);
    const binding = { ref: catalog.catalogRevisionRef, revision: 1n, digest: catalogSource.digest };
    const resolvedCatalog = resolveProductSurfaceCatalogRevision(binding, catalogSource);
    const profile = profileDocument(binding);
    const profileSource = source(profile);
    const resolvedProfile = resolveLaunchProductProfileRevision(
      { ref: profile.profileRevisionRef, revision: 1n, digest: profileSource.digest },
      binding,
      profileSource,
    );

    expect(() => validateLaunchProductProfileClosure(resolvedProfile, resolvedCatalog)).not.toThrow();
    expect(decideCatalogPublication(resolvedCatalog, 0n, {
      headRevision: 0n, existing: null,
    }).kind).toBe("publish");
  });

  it("rejects calendar-invalid canonical timestamps after schema validation", () => {
    const catalog = { ...catalogDocument(), publishedAt: "2026-02-31T00:00:00.000Z" };
    const resolved = source(catalog);
    expect(() => resolveProductSurfaceCatalogRevision({
      ref: catalog.catalogRevisionRef, revision: 1n, digest: resolved.digest,
    }, resolved)).toThrow("PRODUCT_PUBLICATION_TIMESTAMP_INVALID");
  });

  it("bounds deeply nested resolver values before recursive canonicalization", () => {
    let value: unknown = "leaf";
    for (let index = 0; index < 130; index += 1) value = [value];
    const bytes = Buffer.from(JSON.stringify(value));
    expect(() => verifyCanonicalDocument({
      canonicalBytes: bytes,
      parsedDocument: value,
      digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    })).toThrow("PRODUCT_PUBLICATION_IJSON_COMPLEXITY_EXCEEDED");
  });

  it.each([
    9_223_372_036_854_775_808n,
    18_446_744_073_709_551_615n,
  ])("preserves uint64 revision %s beyond PostgreSQL bigint", async (revision) => {
    const document = { ...catalogDocument(), revision: revision.toString() };
    const resolved = source(document);
    const binding = Object.freeze({ ref: document.catalogRevisionRef, revision,
      digest: resolved.digest });
    expect(resolveProductSurfaceCatalogRevision(binding, resolved).binding.revision).toBe(revision);

    const queries: Readonly<{ text: string; values: readonly unknown[] }>[] = [];
    const lease = issuePlatformTransaction({
      query: async <Row extends Record<string, unknown>>(text: string, values = []) => {
        queries.push({ text, values });
        return (text.includes("product_catalog_publication_head")
          ? [{ headRevision: revision.toString() }] : []) as unknown as readonly Row[];
      },
      execute: async () => 0,
    });
    try {
      const snapshot = await new PostgresProductCatalogPublicationRepository()
        .loadCatalogStateForUpdate(lease.transaction, binding);
      expect(snapshot.headRevision).toBe(revision);
    } finally {
      revokePlatformTransaction(lease);
    }
    expect(queries[1]).toMatchObject({ values: [binding.ref, revision.toString()] });
    expect(queries[1]!.text).toContain("$2::numeric(20,0)");
  });

  it("uses NUMERIC(20,0) for every Product publication uint64 persistence column", () => {
    const migration = readFileSync(new URL(
      "../../prisma/migrations/20260815_product_catalog_publication/migration.sql",
      import.meta.url,
    ), "utf8");
    const repository = readFileSync(new URL(
      "../../src/modules/product-catalog/infrastructure/postgres/product-catalog-publication-repository.ts",
      import.meta.url,
    ), "utf8");
    expect(migration).not.toMatch(/\bBIGINT\b/u);
    expect(migration.match(/NUMERIC\(20,0\)/gu)?.length).toBeGreaterThanOrEqual(9);
    expect(repository).not.toContain("::bigint");
    expect(repository.match(/::numeric\(20,0\)/gu)?.length).toBeGreaterThanOrEqual(10);
  });

  it("requires the owner attestation, immutable audit, and immutable revision for replay", async () => {
    const context = await adminContext();
    const binding = Object.freeze({ ref: "catalog.main", revision: 1n,
      digest: `sha256:${"a".repeat(64)}` });
    const command = createProductPublicationCommand({
      commandId: "00000000-0000-4000-8000-000000000011",
      requestDigest: "b".repeat(64), operation: "product.catalog.publish", binding,
      expectedHeadRevision: 0n, reason: "release catalog",
    }, context);
    const row = attestationRow(command);
    const lease = issuePlatformTransaction({ query: async <Row extends Record<string, unknown>>(
      text: string,
    ) => {
      expect(text).toContain("product_catalog_publication_receipt receipt");
      expect(text).toContain("product_catalog_publication_audit audit");
      expect(text).toContain("product_surface_catalog_revision catalog");
      return [row] as unknown as readonly Row[];
    }, execute: async () => 0 });
    try {
      await expect(new PostgresProductCatalogPublicationJournal()
        .findSucceeded(lease.transaction, command)).resolves.toMatchObject({
          binding, publicationReplayed: false, recordedAt: "2026-08-01T00:00:01.000Z",
        });
    } finally {
      revokePlatformTransaction(lease);
    }
  });

  it("rejects a generic succeeded command that lacks an owner publication attestation", async () => {
    const context = await adminContext();
    const binding = Object.freeze({ ref: "catalog.main", revision: 1n,
      digest: `sha256:${"a".repeat(64)}` });
    const command = createProductPublicationCommand({
      commandId: "00000000-0000-4000-8000-000000000012",
      requestDigest: "c".repeat(64), operation: "product.catalog.publish", binding,
      expectedHeadRevision: 0n, reason: "release catalog",
    }, context);
    const journal = new PostgresProductCatalogPublicationJournal({
      begin: async () => ({
        commandId: command.commandId, environment: command.security.environment,
        region: command.security.region, callerIdentity: command.security.callerIdentity,
        operation: command.operation, idempotencyKey: command.idempotencyKey,
        requestDigest: command.requestDigest, state: "succeeded", result: {},
        resultDigest: "d".repeat(64), recordedAt: "2026-08-01T00:00:01.000Z",
      }),
      recordOutcome: async () => { throw new Error("unexpected record outcome"); },
    });
    const lease = issuePlatformTransaction({ query: async () => [], execute: async () => 0 });
    try {
      await expect(journal.begin(lease.transaction, command))
        .rejects.toThrow("PRODUCT_PUBLICATION_OWNER_RECEIPT_MISSING");
    } finally {
      revokePlatformTransaction(lease);
    }
  });

  it("recovers a completed command without consulting the external document source", async () => {
    const context = await adminContext();
    const binding = Object.freeze({ ref: "catalog.main", revision: 1n,
      digest: `sha256:${"a".repeat(64)}` });
    let resolverCalls = 0;
    const journal: ProductCatalogPublicationJournal = {
      findSucceeded: async () => ({ binding, publicationReplayed: false,
        recordedAt: "2026-08-01T00:00:01.000Z" }),
      begin: async () => { throw new Error("unexpected begin"); },
      succeed: async () => { throw new Error("unexpected succeed"); },
    };
    const service = new ProductCatalogPublicationService(unitOfWork(), repositoryNever(), journal, {
      resolve: async () => { resolverCalls += 1; throw new Error("source unavailable"); },
    });

    const result = await service.publishCatalog({
      commandId: "00000000-0000-4000-8000-000000000001",
      requestDigest: "b".repeat(64), binding, expectedHeadRevision: 0n, reason: "release catalog",
    }, context);

    expect(resolverCalls).toBe(0);
    expect(result).toMatchObject({ replayed: true, commandReplayed: true,
      publicationReplayed: false, binding });
  });

  it("rechecks durable completion after resolution to close the concurrent retry race", async () => {
    const context = await adminContext();
    const document = catalogDocument();
    const resolved = source(document);
    const binding = Object.freeze({ ref: document.catalogRevisionRef, revision: 1n,
      digest: resolved.digest });
    let resolverCalls = 0;
    let beginCalls = 0;
    const journal: ProductCatalogPublicationJournal = {
      findSucceeded: async () => null,
      begin: async () => {
        beginCalls += 1;
        return { binding, publicationReplayed: false, recordedAt: "2026-08-01T00:00:02.000Z" };
      },
      succeed: async () => { throw new Error("unexpected succeed"); },
    };
    const service = new ProductCatalogPublicationService(unitOfWork(), repositoryNever(), journal, {
      resolve: async () => { resolverCalls += 1; return resolved; },
    });

    const result = await service.publishCatalog({
      commandId: "00000000-0000-4000-8000-000000000002",
      requestDigest: "c".repeat(64), binding, expectedHeadRevision: 0n, reason: "release catalog",
    }, context);

    expect({ resolverCalls, beginCalls }).toEqual({ resolverCalls: 1, beginCalls: 1 });
    expect(result).toMatchObject({ replayed: true, commandReplayed: true,
      publicationReplayed: false, binding });
  });
});

function catalogDocument() {
  return {
    contract: "kokoro.product-surface-catalog.v1",
    schemaRevision: "1",
    catalogRevisionRef: "catalog.main",
    revision: "1",
    state: "published",
    products: [{
      productRef: "product.chat", revision: "1", surfaceRefs: ["surface.chat"],
      requiredProductRefs: [], canonicalJourneyRefs: ["journey.chat"],
      operationFamilyRefs: ["operation.chat"],
    }],
    surfaces: [{
      surfaceRef: "surface.chat", productRef: "product.chat", revision: "1",
      scopeClass: "core-always", requiredSurfaceRefs: [],
      canonicalJourneyRefs: ["journey.chat"], operationFamilyRefs: ["operation.chat"],
      requiredModelRoleRefs: ["model.assistant"],
    }],
    canonicalJourneys: [{
      journeyRef: "journey.chat", revision: "1", entrySurfaceRef: "surface.chat",
      requiredSurfaceRefs: ["surface.chat"], requiredJourneyRefs: [],
      operationFamilyRefs: ["operation.chat"],
    }],
    operationFamilyRefs: ["operation.chat"],
    publishedAt: "2026-08-01T00:00:00.000Z",
  } as const;
}

function profileDocument(catalogBinding: Readonly<{ ref: string; revision: bigint; digest: string }>) {
  const journeys = [{ journeyRef: "journey.chat", revision: "1" }];
  return {
    contract: "kokoro.launch-product-profile.v1", schemaRevision: "1",
    profileRevisionRef: "profile.main", revision: "1", state: "published",
    targetSiteKindRef: "site.kind",
    productSurfaceCatalog: {
      ref: catalogBinding.ref,
      revision: catalogBinding.revision.toString(),
      digest: catalogBinding.digest,
    },
    enabledSurfaceRefs: ["surface.chat"],
    journeyClosure: { journeys, digest: canonicalDigest(journeys) },
    shellRequirementRefs: ["shell.main"],
    policies: {
      assortmentPolicyRef: "policy.assortment", modelPolicyRef: "policy.model",
      agentPolicyRef: "policy.agent", capabilityPolicyRef: "policy.capability",
      authMethodPolicyRevisionRef: "policy.auth", salesPolicyRevisionRef: "policy.sales",
      contentPolicyProfileRef: "policy.content", localeAccessibilityBaselineRef: "policy.locale",
      metricTargetRevisionRef: "policy.metric", supportTierRevisionRef: "policy.support",
      operatorCommandMatrixRevisionRef: "policy.operator", certificationPolicyRef: "policy.certification",
    },
    reviewApprovalRefs: ["approval.main"], publishedAt: "2026-08-01T00:00:01.000Z",
  } as const;
}

function source(document: unknown) {
  const text = canonicalJson(document);
  const canonicalBytes = Buffer.from(text);
  return Object.freeze({ canonicalBytes, parsedDocument: document,
    digest: `sha256:${createHash("sha256").update(canonicalBytes).digest("hex")}` });
}

function unitOfWork(): PlatformUnitOfWork {
  const host: PlatformTransactionHost = {
    async transaction(_fence, work) {
      const lease = issuePlatformTransaction({ query: async () => [], execute: async () => 0 });
      try { return await work(lease.transaction); }
      finally { revokePlatformTransaction(lease); }
    },
  };
  return new PlatformUnitOfWork(host, () => "2026-08-01T00:00:30.000Z");
}

function repositoryNever(): ProductCatalogPublicationRepository {
  const fail = async (): Promise<never> => { throw new Error("unexpected repository call"); };
  return { loadCatalogStateForUpdate: fail, loadProfileStateForUpdate: fail,
    loadPublishedCatalog: fail, persistCatalog: fail, persistProfile: fail, recordReplay: fail };
}

async function adminContext() {
  const caller = {
    workloadIdentityId: "platform-admin", kind: "admin_workload" as const,
    audience: "platform-admin", environment: "production", region: "us-east-1",
    allowedOperations: ["product.catalog.publish"], bindingEpoch: "1",
    siteId: null,
    issuedAt: "2026-08-01T00:00:00.000Z", expiresAt: "2026-08-01T00:01:00.000Z",
    issuer: "spiffe://kokoro.test", keyVersion: "1",
  };
  return verifyRequestSecurityContext({
    requestId: "request-1", correlationId: "correlation-1",
    trustedCaller: {
      kind: caller.kind, workloadIdentityId: caller.workloadIdentityId,
      audience: caller.audience, environment: caller.environment, region: caller.region,
      allowedOperations: caller.allowedOperations, bindingEpoch: caller.bindingEpoch,
      issuedAt: caller.issuedAt, expiresAt: caller.expiresAt,
    },
    actor: { kind: "operator", subjectId: "operator-1", subjectGeneration: "1" },
    delegatedGrant: null,
    target: { siteId: null, workspaceId: null, projectId: null,
      purpose: "product.catalog.publish", scopes: ["admin:global", "product.catalog.publish"] },
    audience: caller.audience, environment: caller.environment, region: caller.region,
    evidence: [{ kind: "mtls-workload", evidenceId: "platform-admin", issuer: caller.issuer }],
    policyEpoch: "1", issuedAt: caller.issuedAt, expiresAt: caller.expiresAt,
  }, {
    now: "2026-08-01T00:00:30.000Z", operation: "product.catalog.publish",
    expectedAudience: caller.audience, expectedEnvironment: caller.environment,
    expectedRegion: caller.region, callerVerifier: { verify: async () => caller },
  });
}

function attestationRow(command: ReturnType<typeof createProductPublicationCommand>) {
  return {
    commandId: command.commandId, operation: command.operation,
    environment: command.security.environment, region: command.security.region,
    callerIdentity: command.security.callerIdentity, idempotencyKey: command.idempotencyKey,
    requestDigest: command.requestDigest, revisionRef: command.binding.ref,
    revision: command.binding.revision.toString(), digest: command.binding.digest,
    catalogRevisionRef: null, catalogRevision: null, catalogDigest: null,
    publicationReplayed: false, recordedAt: "2026-08-01T00:00:01.000Z",
    auditOperation: command.operation, auditRevisionRef: command.binding.ref,
    auditRevision: command.binding.revision.toString(), auditDigest: command.binding.digest,
    auditCatalogRevisionRef: null, auditCatalogRevision: null, auditCatalogDigest: null,
    auditExpectedHeadRevision: command.expectedHeadRevision.toString(), auditReason: command.reason,
    auditActorSubjectId: command.security.actorSubjectId,
    auditEnvironment: command.security.environment, auditRegion: command.security.region,
    auditReplayed: false, catalogRevisionPresent: true, profileRevisionPresent: false,
  };
}
