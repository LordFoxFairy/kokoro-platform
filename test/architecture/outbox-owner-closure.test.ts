import { readFile } from "node:fs/promises";
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

const workerProcess = "src/process/worker.ts";

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
      identity: { consumer: "identity-worker", closure: "reserved",
        eventTypes: identityEventTypes, process: null },
      commerce: { consumer: "commerce-worker", closure: "active",
        eventTypes: ["commerce.redemption.fulfilled.v1"],
        process: { module: workerProcess, symbol: "createCommerceOutboxReconciliationCycle" } },
      credit: { consumer: "commerce-worker", closure: "active", eventTypes: [
        "credit.reserve_root.v1", "credit.finalize_segment.v1",
        "credit.release_segment.v1", "credit.reconcile_segment.v1",
      ], process: { module: workerProcess, symbol: "createCommerceOutboxReconciliationCycle" } },
      site: { consumer: "site-worker", closure: "active", eventTypes: [
        "site.activation.begin.v1", "site.traffic-stop.request.v1",
      ], process: { module: workerProcess, symbol: "createSiteRuntimeWorkerProductionComposition" } },
      asset: { consumer: "asset-worker", closure: "active", eventTypes: [
        "asset.upload.completion.requested", "asset.scan.requested",
        "asset.blob.promotion.requested", "asset.object.cleanup.requested",
      ], process: { module: workerProcess, symbol: "createAssetWorkerProductionComposition" } },
      "admin-execution": { consumer: "admin-worker", closure: "active",
        eventTypes: ["admin.approval.execution.requested"],
        process: { module: workerProcess, symbol: "createAdminWorkerExecutionRuntime" } },
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
    expect(() => assertOutboxEventRoute("identity", "identity.totp.enrollment_started"))
      .toThrow("OUTBOX_EVENT_ROUTE_UNREGISTERED");
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
});
