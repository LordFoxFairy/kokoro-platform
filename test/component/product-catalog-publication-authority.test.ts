import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { describe, expect, it } from "vitest";
import {
  createPlatformDatabaseClient,
  loadPlatformDatabaseConfig,
} from "../../src/infrastructure/postgres/client.js";
import { runPlatformMigrations } from "../../src/infrastructure/postgres/migrator.js";
import type { ProductPublicationDocumentResolver } from
  "../../src/modules/product-catalog/application/contracts/product-publication-document-resolver.js";
import {
  canonicalDigest,
  canonicalJson,
  type ResolvedCanonicalDocument,
} from "../../src/modules/product-catalog/domain/canonical-product-document.js";
import type { ImmutableRevisionBinding } from
  "../../src/modules/product-catalog/domain/product-publication.js";
import { createProductCatalogAdministrationComposition } from
  "../../src/process/product-catalog-admin-composition.js";
import { verifyRequestSecurityContext } from
  "../../src/shared/security-context/request-security-context.js";

const migratorUrl = leased(process.env.DATABASE_URL_PLATFORM_MIGRATOR_TEST);
const bootstrapUrl = leased(process.env.DATABASE_URL_PLATFORM_BOOTSTRAP_TEST);
const adminUrl = leased(process.env.DATABASE_URL_PLATFORM_ADMIN_TEST);
const adminRole = role(process.env.PLATFORM_DATABASE_ADMIN_ROLE);
const migratorRole = role(process.env.PLATFORM_DATABASE_MIGRATOR_ROLE);
const databaseName = new URL(migratorUrl).pathname.slice(1);

describe("Product Catalog PostgreSQL publication authority", () => {
  it("publishes and replays Catalog and Profile while rejecting every mismatched RLS axis", async () => {
    await runPlatformMigrations({
      environment: {
        ...process.env,
        DATABASE_URL_PLATFORM: migratorUrl,
        PLATFORM_DATABASE_CREDENTIAL_CLASS: "migrator",
      },
    });
    const suffix = randomUUID().replaceAll("-", "");
    const catalogDocument = productCatalogDocument(`catalog.component.${suffix}`);
    const catalogSource = source(catalogDocument);
    const catalog = binding(catalogDocument.catalogRevisionRef, catalogSource);
    const profileDocument = launchProfileDocument(`profile.component.${suffix}`, catalog);
    const profileSource = source(profileDocument);
    const profile = binding(profileDocument.profileRevisionRef, profileSource);
    const documents = documentResolver([
      ["product-surface-catalog", catalog, catalogSource],
      ["launch-product-profile", profile, profileSource],
    ]);
    const catalogCommandId = randomUUID();
    const profileCommandId = randomUUID();
    const bootstrap = new Client({ connectionString: bootstrapUrl });
    const rawAdmin = new Client({ connectionString: adminUrl });
    const admin = createPlatformDatabaseClient(loadPlatformDatabaseConfig("admin", {
      DATABASE_URL_PLATFORM: adminUrl,
      PLATFORM_DATABASE_CREDENTIAL_CLASS: "admin",
      PLATFORM_DATABASE_ADMIN_ROLE: adminRole,
      PLATFORM_DATABASE_MIGRATOR_ROLE: migratorRole,
      PLATFORM_DATABASE_EXPECTED_DATABASE: databaseName,
    }));
    await Promise.all([bootstrap.connect(), rawAdmin.connect(), admin.connect()]);
    try {
      const owner = createProductCatalogAdministrationComposition(admin, documents);
      const catalogCommand = {
        commandId: catalogCommandId,
        idempotencyKey: `catalog-publication-${suffix}`,
        requestDigest: "a".repeat(64),
        binding: catalog,
        expectedHeadRevision: 0n,
        reason: "publish component product catalog",
      } as const;
      const catalogContext = await adminContext("product.catalog.publish");
      await expect(owner.publishCatalog(catalogCommand, catalogContext)).resolves.toMatchObject({
        binding: catalog,
        replayed: false,
        commandReplayed: false,
        publicationReplayed: false,
      });
      await expect(owner.publishCatalog(catalogCommand, catalogContext)).resolves.toMatchObject({
        binding: catalog,
        replayed: true,
        commandReplayed: true,
        publicationReplayed: false,
      });

      const profileCommand = {
        commandId: profileCommandId,
        idempotencyKey: `profile-publication-${suffix}`,
        requestDigest: "b".repeat(64),
        binding: profile,
        catalogBinding: catalog,
        expectedHeadRevision: 0n,
        reason: "publish component launch profile",
      } as const;
      const profileContext = await adminContext("product.launch-profile.publish");
      await expect(owner.publishProfile(profileCommand, profileContext)).resolves.toMatchObject({
        binding: profile,
        replayed: false,
        commandReplayed: false,
        publicationReplayed: false,
      });
      await expect(owner.publishProfile(profileCommand, profileContext)).resolves.toMatchObject({
        binding: profile,
        replayed: true,
        commandReplayed: true,
        publicationReplayed: false,
      });

      const persisted = await bootstrap.query<{
        catalog_head_ref: string;
        profile_head_ref: string;
        catalog_revisions: string;
        profile_revisions: string;
        audits: string;
        owner_receipts: string;
        succeeded_commands: string;
      }>(
        `SELECT
           (SELECT head_ref FROM platform.product_catalog_publication_head
             WHERE publication_kind='catalog') AS catalog_head_ref,
           (SELECT head_ref FROM platform.product_catalog_publication_head
             WHERE publication_kind='profile') AS profile_head_ref,
           (SELECT count(*)::text FROM platform.product_surface_catalog_revision
             WHERE catalog_revision_ref=$1) AS catalog_revisions,
           (SELECT count(*)::text FROM platform.launch_product_profile_revision
             WHERE profile_revision_ref=$2) AS profile_revisions,
           (SELECT count(*)::text FROM platform.product_catalog_publication_audit
             WHERE command_id=ANY($3::text[])) AS audits,
           (SELECT count(*)::text FROM platform.product_catalog_publication_receipt
             WHERE command_id=ANY($3::text[])) AS owner_receipts,
           (SELECT count(*)::text FROM platform.command_receipt
             WHERE command_id=ANY($3::text[]) AND state='succeeded') AS succeeded_commands`,
        [catalog.ref, profile.ref, [catalogCommandId, profileCommandId]],
      );
      expect(persisted.rows[0]).toEqual({
        catalog_head_ref: catalog.ref,
        profile_head_ref: profile.ref,
        catalog_revisions: "1",
        profile_revisions: "1",
        audits: "2",
        owner_receipts: "2",
        succeeded_commands: "2",
      });

      await expect(publicationVisibility(rawAdmin, catalog.ref, profile.ref, {
        workload: "admin_workload",
        operation: "product.catalog.publish",
        siteId: "",
        scopes: ["admin:global", "product.catalog.publish"],
      })).resolves.toEqual({ heads: 1, catalogs: 1, profiles: 0, audits: 1, receipts: 1,
        updatedHeads: 1 });
      await expect(publicationVisibility(rawAdmin, catalog.ref, profile.ref, {
        workload: "admin_workload",
        operation: "product.launch-profile.publish",
        siteId: "",
        scopes: ["admin:global", "product.launch-profile.publish"],
      })).resolves.toEqual({ heads: 1, catalogs: 1, profiles: 1, audits: 1, receipts: 1,
        updatedHeads: 1 });

      for (const axes of [
        {
          workload: "platform_admin",
          operation: "product.catalog.publish",
          siteId: "",
          scopes: ["admin:global", "product.catalog.publish"],
        },
        {
          workload: "admin_workload",
          operation: "product.catalog.publish",
          siteId: `site.forbidden.${suffix}`,
          scopes: ["admin:global", "product.catalog.publish"],
        },
        {
          workload: "admin_workload",
          operation: "product.catalog.publish",
          siteId: "",
          scopes: ["product.catalog.publish"],
        },
        {
          workload: "admin_workload",
          operation: "site.register",
          siteId: "",
          scopes: ["admin:global", "site.register"],
        },
      ] as const) {
        await expect(publicationVisibility(rawAdmin, catalog.ref, profile.ref, axes)).resolves.toEqual({
          heads: 0,
          catalogs: 0,
          profiles: 0,
          audits: 0,
          receipts: 0,
          updatedHeads: 0,
        });
      }
    } finally {
      await Promise.allSettled([admin.disconnect(), rawAdmin.end()]);
      try {
        await cleanup(bootstrap, catalogCommandId, profileCommandId);
      } finally {
        await bootstrap.end();
      }
    }
  }, 60_000);
});

type PublicationOperation = "product.catalog.publish" | "product.launch-profile.publish";

async function adminContext(operation: PublicationOperation) {
  const now = new Date();
  const issuedAt = new Date(now.getTime() - 60_000).toISOString();
  const expiresAt = new Date(now.getTime() + 600_000).toISOString();
  const issuer = "spiffe://kokoro.test/admin/product-publication";
  const caller = {
    workloadIdentityId: "spiffe://kokoro.test/admin/component",
    kind: "admin_workload" as const,
    audience: "platform-admin",
    environment: "production",
    region: "us-east-1",
    allowedOperations: [operation],
    siteId: null,
    bindingEpoch: "1",
    issuedAt,
    expiresAt,
    issuer,
    keyVersion: "component-1",
  };
  return verifyRequestSecurityContext({
    requestId: randomUUID(),
    correlationId: randomUUID(),
    trustedCaller: {
      kind: caller.kind,
      workloadIdentityId: caller.workloadIdentityId,
      audience: caller.audience,
      environment: caller.environment,
      region: caller.region,
      allowedOperations: caller.allowedOperations,
      bindingEpoch: caller.bindingEpoch,
      issuedAt: caller.issuedAt,
      expiresAt: caller.expiresAt,
    },
    actor: {
      kind: "operator",
      subjectId: "operator:product-publication-component",
      subjectGeneration: "1",
    },
    delegatedGrant: null,
    target: {
      siteId: null,
      workspaceId: null,
      projectId: null,
      purpose: operation,
      scopes: ["admin:global", operation],
    },
    audience: caller.audience,
    environment: caller.environment,
    region: caller.region,
    evidence: [{ kind: "workload_attestation", evidenceId: "product-publication-component", issuer }],
    policyEpoch: "1",
    issuedAt,
    expiresAt,
  }, {
    now: now.toISOString(),
    operation,
    expectedAudience: caller.audience,
    expectedEnvironment: caller.environment,
    expectedRegion: caller.region,
    callerVerifier: { verify: async () => caller },
  });
}

async function publicationVisibility(
  client: Client,
  catalogRef: string,
  profileRef: string,
  axes: Readonly<{
    workload: string;
    operation: string;
    siteId: string;
    scopes: readonly string[];
  }>,
) {
  await client.query("BEGIN");
  try {
    await client.query(
      `SELECT set_config('app.workload_kind',$1,true),
              set_config('app.actor_kind','operator',true),
              set_config('app.operation',$2,true),
              set_config('app.site_id',$3,true),
              set_config('app.scopes',$4,true)`,
      [axes.workload, axes.operation, axes.siteId, JSON.stringify(axes.scopes)],
    );
    const visible = await client.query<{
      heads: number;
      catalogs: number;
      profiles: number;
      audits: number;
      receipts: number;
    }>(
      `SELECT
         (SELECT count(*)::int FROM platform.product_catalog_publication_head) AS heads,
         (SELECT count(*)::int FROM platform.product_surface_catalog_revision
           WHERE catalog_revision_ref=$1) AS catalogs,
         (SELECT count(*)::int FROM platform.launch_product_profile_revision
           WHERE profile_revision_ref=$2) AS profiles,
         (SELECT count(*)::int FROM platform.product_catalog_publication_audit
           WHERE revision_ref IN ($1,$2)) AS audits,
         (SELECT count(*)::int FROM platform.product_catalog_publication_receipt
           WHERE revision_ref IN ($1,$2)) AS receipts`,
      [catalogRef, profileRef],
    );
    const updated = await client.query(
      `UPDATE platform.product_catalog_publication_head SET updated_at=updated_at
       WHERE publication_kind=CASE $1 WHEN 'product.catalog.publish' THEN 'catalog'
                              WHEN 'product.launch-profile.publish' THEN 'profile'
                              ELSE 'catalog' END`,
      [axes.operation],
    );
    await client.query("ROLLBACK");
    return { ...visible.rows[0]!, updatedHeads: updated.rowCount ?? 0 };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function cleanup(client: Client, catalogCommandId: string, profileCommandId: string) {
  await client.query("BEGIN");
  try {
    await client.query("SET LOCAL session_replication_role='replica'");
    const commandIds = [catalogCommandId, profileCommandId];
    await client.query(
      "DELETE FROM platform.product_catalog_publication_receipt WHERE command_id=ANY($1::text[])",
      [commandIds],
    );
    await client.query(
      "DELETE FROM platform.product_catalog_publication_audit WHERE command_id=ANY($1::text[])",
      [commandIds],
    );
    await client.query(
      "DELETE FROM platform.launch_product_profile_revision WHERE command_id=$1",
      [profileCommandId],
    );
    await client.query(
      "DELETE FROM platform.product_surface_catalog_revision WHERE command_id=$1",
      [catalogCommandId],
    );
    await client.query(
      `UPDATE platform.product_catalog_publication_head
       SET head_revision=0,head_ref=NULL,head_digest=NULL,updated_at=clock_timestamp()
       WHERE publication_kind IN ('catalog','profile')`,
    );
    await client.query(
      "DELETE FROM platform.command_receipt WHERE command_id=ANY($1::text[])",
      [commandIds],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

function documentResolver(
  entries: readonly (readonly [
    "product-surface-catalog" | "launch-product-profile",
    ImmutableRevisionBinding,
    ResolvedCanonicalDocument,
  ])[],
): ProductPublicationDocumentResolver {
  const documents = new Map(entries.map(([kind, value, document]) => [
    `${kind}:${value.ref}:${value.revision}:${value.digest}`,
    document,
  ]));
  const resolver: ProductPublicationDocumentResolver = {
    async resolve(input) {
      const key = `${input.kind}:${input.binding.ref}:${input.binding.revision}:${input.binding.digest}`;
      const document = documents.get(key);
      if (document === undefined) throw new Error("PRODUCT_PUBLICATION_COMPONENT_DOCUMENT_MISSING");
      return document;
    },
  };
  return Object.freeze(resolver);
}

function productCatalogDocument(catalogRevisionRef: string) {
  return {
    contract: "kokoro.product-surface-catalog.v1",
    schemaRevision: "1",
    catalogRevisionRef,
    revision: "1",
    state: "published",
    products: [{
      productRef: "product.chat",
      revision: "1",
      surfaceRefs: ["surface.chat"],
      requiredProductRefs: [],
      canonicalJourneyRefs: ["journey.chat"],
      operationFamilyRefs: ["operation.chat"],
    }],
    surfaces: [{
      surfaceRef: "surface.chat",
      productRef: "product.chat",
      revision: "1",
      scopeClass: "core-always",
      requiredSurfaceRefs: [],
      canonicalJourneyRefs: ["journey.chat"],
      operationFamilyRefs: ["operation.chat"],
      requiredModelRoleRefs: ["model.assistant"],
    }],
    canonicalJourneys: [{
      journeyRef: "journey.chat",
      revision: "1",
      entrySurfaceRef: "surface.chat",
      requiredSurfaceRefs: ["surface.chat"],
      requiredJourneyRefs: [],
      operationFamilyRefs: ["operation.chat"],
    }],
    operationFamilyRefs: ["operation.chat"],
    publishedAt: "2026-08-08T00:00:00.000Z",
  } as const;
}

function launchProfileDocument(profileRevisionRef: string, catalog: ImmutableRevisionBinding) {
  const journeys = [{ journeyRef: "journey.chat", revision: "1" }] as const;
  return {
    contract: "kokoro.launch-product-profile.v1",
    schemaRevision: "1",
    profileRevisionRef,
    revision: "1",
    state: "published",
    targetSiteKindRef: "site.kind.component",
    productSurfaceCatalog: {
      ref: catalog.ref,
      revision: catalog.revision.toString(),
      digest: catalog.digest,
    },
    enabledSurfaceRefs: ["surface.chat"],
    journeyClosure: { journeys, digest: canonicalDigest(journeys) },
    shellRequirementRefs: ["shell.main"],
    policies: {
      assortmentPolicyRef: "policy.assortment",
      modelPolicyRef: "policy.model",
      agentPolicyRef: "policy.agent",
      capabilityPolicyRef: "policy.capability",
      authMethodPolicyRevisionRef: "policy.auth",
      salesPolicyRevisionRef: "policy.sales",
      contentPolicyProfileRef: "policy.content",
      localeAccessibilityBaselineRef: "policy.locale",
      metricTargetRevisionRef: "policy.metric",
      supportTierRevisionRef: "policy.support",
      operatorCommandMatrixRevisionRef: "policy.operator",
      certificationPolicyRef: "policy.certification",
    },
    reviewApprovalRefs: ["approval.component"],
    publishedAt: "2026-08-08T00:00:01.000Z",
  } as const;
}

function source(document: unknown): ResolvedCanonicalDocument {
  const canonicalBytes = Buffer.from(canonicalJson(document), "utf8");
  return Object.freeze({ canonicalBytes, parsedDocument: document, digest: canonicalDigest(document) });
}

function binding(ref: string, document: ResolvedCanonicalDocument): ImmutableRevisionBinding {
  return Object.freeze({ ref, revision: 1n, digest: document.digest });
}

function leased(value: string | undefined): string {
  if (value === undefined) throw new Error("PLATFORM_POSTGRES_LEASE_URL_REQUIRED");
  const url = new URL(value);
  if (!url.pathname.slice(1).startsWith("kokoro_test_")) {
    throw new Error("DATABASE_URL_PLATFORM_TEST_MUST_BE_LEASED");
  }
  return value;
}

function role(value: string | undefined): string {
  if (value === undefined || !/^[a-z_][a-z0-9_]{0,62}$/u.test(value)) {
    throw new Error("PLATFORM_POSTGRES_ROLE_REQUIRED");
  }
  return value;
}
