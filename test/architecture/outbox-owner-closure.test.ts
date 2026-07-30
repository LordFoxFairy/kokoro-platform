import { readdir, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  OUTBOX_ROUTE_CATALOG,
  OUTBOX_OWNER_CONSUMER_REGISTRY,
  assertOutboxEventRoute,
  outboxEventTypesForConsumer,
  outboxOwnersForConsumer,
} from "../../src/shared/outbox-inbox/outbox.js";
import { ADMIN_EXECUTION_EVENT_TYPES } from
  "../../src/modules/admin-control/application/admin-execution-cycle.js";
import { ASSET_EFFECT_EVENT_TYPES } from
  "../../src/modules/asset/infrastructure/postgres/asset-outbox-consumer.js";
import { COMMERCE_OUTBOX_EVENT_TYPES } from
  "../../src/modules/commerce/infrastructure/postgres/commerce-outbox-reconciler.js";
import { SITE_EFFECT_EVENT_TYPES } from
  "../../src/modules/site/infrastructure/postgres/site-outbox-consumer.js";

const expectedClosure = Object.freeze({
  identity: "identity-worker",
  commerce: "commerce-worker",
  credit: "commerce-worker",
  site: "site-worker",
  asset: "asset-worker",
  "admin-execution": "admin-worker",
} as const);

const identityEventTypes = [
  "identity.verification.delivery.requested",
  "identity.namespace.allocation.requested",
] as const;

const localIdentitySecurityEventTypes = [
  "identity.reauthentication.challenge_started",
  "identity.reauthentication.proof_issued",
  "identity.reauthentication.proof_superseded",
  "identity.recovery_codes.delivery_superseded",
  "identity.recovery_codes.regenerated",
  "identity.totp.disabled",
  "identity.totp.enrollment_confirmed",
  "identity.totp.enrollment_started",
  "identity.totp.enrollment_superseded",
] as const;

const outboxBackedEffectTables = [
  "asset_blob_candidate",
  "asset_object_cleanup",
  "asset_promotion_intent",
  "commerce_command_outbox",
  "credit_budget_operation_receipt",
  "identity_namespace_allocation_intent",
  "identity_verification_delivery",
] as const;

describe("Platform outbox producer to consumer closure", () => {
  it("keeps the complete owner set closed over one real worker authority", () => {
    expect(OUTBOX_OWNER_CONSUMER_REGISTRY).toEqual(expectedClosure);
    expect(outboxOwnersForConsumer("identity-worker")).toEqual(["identity"]);
    expect(outboxOwnersForConsumer("commerce-worker")).toEqual(["commerce", "credit"]);
    expect(outboxOwnersForConsumer("site-worker")).toEqual(["site"]);
    expect(outboxOwnersForConsumer("asset-worker")).toEqual(["asset"]);
    expect(outboxOwnersForConsumer("admin-worker")).toEqual(["admin-execution"]);
  });

  it("maps every exact producer event type to one consumer and process composition", async () => {
    expect(OUTBOX_ROUTE_CATALOG).toEqual({
      identity: { consumer: "identity-worker", closure: "active",
        eventTypes: identityEventTypes,
        process: { module: "src/process/identity-worker.ts", symbol: "runPlatformIdentityWorkerMain" } },
      commerce: { consumer: "commerce-worker", closure: "active",
        eventTypes: ["commerce.redemption.fulfilled.v1"],
        process: { module: "src/process/commerce-worker.ts", symbol: "createCommerceOutboxReconciliationCycle" } },
      credit: { consumer: "commerce-worker", closure: "active", eventTypes: [
        "credit.reserve_root.v1", "credit.finalize_segment.v1",
        "credit.release_segment.v1", "credit.reconcile_segment.v1",
      ], process: { module: "src/process/commerce-worker.ts", symbol: "createCommerceOutboxReconciliationCycle" } },
      site: { consumer: "site-worker", closure: "active", eventTypes: [
        "site.activation.begin.v1", "site.traffic-stop.request.v1",
      ], process: { module: "src/process/site-worker.ts", symbol: "createSiteRuntimeWorkerProductionComposition" } },
      asset: { consumer: "asset-worker", closure: "active", eventTypes: [
        "asset.upload.completion.requested", "asset.scan.requested",
        "asset.blob.promotion.requested", "asset.object.cleanup.requested",
      ], process: { module: "src/process/asset-worker.ts", symbol: "createAssetWorkerProductionComposition" } },
      "admin-execution": { consumer: "admin-worker", closure: "active",
        eventTypes: ["admin.approval.execution.requested"],
        process: { module: "src/process/admin-worker.ts", symbol: "createAdminWorkerExecutionRuntime" } },
    });
    for (const route of Object.values(OUTBOX_ROUTE_CATALOG)) {
      if (route.closure !== "active") continue;
      const source = await readFile(route.process.module, "utf8");
      expect(source).toContain(route.process.symbol);
    }
    expect(outboxEventTypesForConsumer("site-worker")).toEqual([
      "site.activation.begin.v1", "site.traffic-stop.request.v1",
    ]);
    expect(outboxEventTypesForConsumer("commerce-worker")).toEqual([
      "commerce.redemption.fulfilled.v1", "credit.reserve_root.v1",
      "credit.finalize_segment.v1", "credit.release_segment.v1",
      "credit.reconcile_segment.v1",
    ]);
    expect(ASSET_EFFECT_EVENT_TYPES).toEqual(outboxEventTypesForConsumer("asset-worker"));
    expect(SITE_EFFECT_EVENT_TYPES).toEqual(outboxEventTypesForConsumer("site-worker"));
    expect(COMMERCE_OUTBOX_EVENT_TYPES).toEqual(outboxEventTypesForConsumer("commerce-worker"));
    expect(ADMIN_EXECUTION_EVENT_TYPES).toEqual(outboxEventTypesForConsumer("admin-worker"));
  });

  it("rejects event types without an exact producer-to-consumer route", () => {
    expect(() => assertOutboxEventRoute("asset", "asset.version.ready"))
      .toThrow("OUTBOX_EVENT_ROUTE_UNREGISTERED");
    expect(() => assertOutboxEventRoute("site", "site.register.v1"))
      .toThrow("OUTBOX_EVENT_ROUTE_UNREGISTERED");
    for (const eventType of localIdentitySecurityEventTypes) {
      expect(() => assertOutboxEventRoute("identity", eventType))
        .toThrow("OUTBOX_EVENT_ROUTE_UNREGISTERED");
    }
  });

  it("enforces the same closed owner set at the PostgreSQL boundary", async () => {
    const migration = await readFile(new URL(
      "../../prisma/migrations/0002_platform_transaction_kernel/migration.sql",
      import.meta.url,
    ), "utf8");
    expect(migration).toContain(
      "owner TEXT NOT NULL CHECK (owner IN ('identity','commerce','credit','site','asset','admin-execution'))",
    );
    expect(migration).toContain("'identity.verification.delivery.requested','identity.namespace.allocation.requested'");
    expect(migration).toContain("owner='site' AND event_type IN ('site.activation.begin.v1','site.traffic-stop.request.v1')");
    expect(migration).toContain("owner='asset' AND event_type IN ('asset.upload.completion.requested','asset.scan.requested','asset.blob.promotion.requested','asset.object.cleanup.requested')");
    expect(migration).not.toContain("asset.version.ready");
    expect(migration).not.toContain("site.register.v1");
    expect(migration).not.toContain("identity.totp.enrollment_started");
    for (const orphan of ["admin-control", "model-control", "credit-usage-rating"]) {
      expect(migration).not.toContain(`'${orphan}'`);
    }
  });

  it("does not publish Asset readiness as an ownerless downstream effect", async () => {
    const [service, repository] = await Promise.all([
      readFile(new URL(
        "../../src/modules/asset/application/services/process-asset-promotion.ts",
        import.meta.url,
      ), "utf8"),
      readFile(new URL(
        "../../src/modules/asset/infrastructure/postgres/asset-promotion-repository.ts",
        import.meta.url,
      ), "utf8"),
    ]);
    expect(service).not.toContain("asset.version.ready");
    expect(service).not.toContain("readyEvent");
    expect(repository).not.toContain("readyEvent");
  });

  it("keeps Identity security facts local while preserving its two real effect producers", async () => {
    const [securityManagement, identityApplication, composition] = await Promise.all([
      readFile(new URL(
        "../../src/modules/identity/application/services/identity-security-management-service.ts",
        import.meta.url,
      ), "utf8"),
      readFile(new URL(
        "../../src/modules/identity/application/services/identity-application-service.ts",
        import.meta.url,
      ), "utf8"),
      readFile(new URL("../../src/process/platform-public-composition.ts", import.meta.url), "utf8"),
    ]);
    expect(securityManagement).toContain("appendSecurityEvent");
    expect(securityManagement).not.toContain("IdentityOutboxPort");
    expect(securityManagement).not.toContain("OutboxEvent");
    expect(securityManagement).not.toContain("dependencies.outbox");
    for (const eventType of localIdentitySecurityEventTypes) {
      expect(securityManagement).toContain(`"${eventType}"`);
    }
    const securityComposition = composition.slice(
      composition.indexOf("const identitySecurityManagement"),
      composition.indexOf("const authorizationOperations"),
    );
    expect(securityComposition).not.toContain("outbox:");
    const effectEventTypes = [...identityApplication.matchAll(/eventType: "(identity\.[^"]+)"/gu)]
      .map((match) => match[1]);
    expect([...new Set(effectEventTypes)]).toEqual(identityEventTypes);
  });

  it("gives local Identity security facts independent event ids and reserves outbox FKs for effects", async () => {
    const [identityMigration, prismaSchema] = await Promise.all([
      readFile(new URL(
        "../../prisma/migrations/20260729_identity_core/migration.sql",
        import.meta.url,
      ), "utf8"),
      readFile(new URL("../../prisma/schema.prisma", import.meta.url), "utf8"),
    ]);
    const securityEventTable = tableDefinition(identityMigration, "identity_security_event");
    expect(securityEventTable).toContain("event_id UUID PRIMARY KEY,");
    expect(securityEventTable).not.toContain("REFERENCES platform.outbox_event(event_id)");
    const securityEventModel = prismaSchema.slice(
      prismaSchema.indexOf("model IdentitySecurityEvent {"),
      prismaSchema.indexOf("model IdentityRefreshFamily {"),
    );
    expect(securityEventModel).toContain("eventId              String   @id @map(\"event_id\") @db.Uuid");
    expect(securityEventModel).not.toMatch(/outbox/iu);
    expect(tableDefinition(identityMigration, "identity_verification_delivery"))
      .toContain("event_id UUID NOT NULL UNIQUE REFERENCES platform.outbox_event(event_id)");
    expect(tableDefinition(identityMigration, "identity_namespace_allocation_intent"))
      .toContain("event_id UUID NOT NULL UNIQUE REFERENCES platform.outbox_event(event_id)");

    const migrationsDirectory = new URL("../../prisma/migrations/", import.meta.url);
    const migrationEntries = await readdir(migrationsDirectory, { withFileTypes: true });
    const outboxForeignKeyTables = new Set<string>();
    for (const entry of migrationEntries) {
      if (!entry.isDirectory()) continue;
      const migration = await readFile(new URL(`${entry.name}/migration.sql`, migrationsDirectory), "utf8");
      for (const match of migration.matchAll(
        /CREATE TABLE platform\.([a-z0-9_]+) \(([\s\S]*?)\n\);/gu,
      )) {
        if (match[1] !== undefined && match[2]?.includes(
          "REFERENCES platform.outbox_event(event_id)",
        )) outboxForeignKeyTables.add(match[1]);
      }
    }
    expect([...outboxForeignKeyTables].sort()).toEqual([...outboxBackedEffectTables].sort());
  });
});

function tableDefinition(migration: string, table: string): string {
  const start = migration.indexOf(`CREATE TABLE platform.${table} (`);
  if (start < 0) throw new Error(`TABLE_DEFINITION_MISSING:${table}`);
  const end = migration.indexOf("\n);", start);
  if (end < 0) throw new Error(`TABLE_DEFINITION_UNTERMINATED:${table}`);
  return migration.slice(start, end + 3);
}
