import { describe, expect, it } from "vitest";
import { canonicalizeModelInventory } from "../../src/modules/model-control/domain/model-catalog.js";
import {
  compileModelOptionRevision,
  createSiteReleaseModelCatalogRevision,
} from "../../src/modules/model-control/domain/product-model-option.js";
import {
  PostgresProductModelOptionCatalogReader,
  PostgresProductModelOptionRepository,
} from "../../src/modules/model-control/infrastructure/postgres/product-model-option-repository.js";
import type { ModelOptionCatalogRepository } from "../../src/modules/model-control/application/contracts/product-model-option-ports.js";
import type { VerifiedRequestSecurityContext } from "../../src/shared/security-context/index.js";
import {
  issuePlatformTransaction,
  revokePlatformTransaction,
} from "../../src/shared/unit-of-work/platform-transaction.js";

describe("Postgres Product ModelOption repository", () => {
  it("loads and re-canonicalizes an exact inventory through the owner function", async () => {
    const fixture = catalogFixture();
    const calls: { statement: string; values: readonly unknown[] }[] = [];
    const lease = issuePlatformTransaction({
      query: async <Row extends Record<string, unknown>>(statement: string, values = []) => {
        calls.push({ statement, values });
        return [{ canonicalPayload: fixture.inventory.document }] as unknown as readonly Row[];
      },
      execute: async () => 0,
    });
    try {
      await expect(
        new PostgresProductModelOptionRepository().loadInventory(
          lease.transaction,
          fixture.inventory.digest,
        ),
      ).resolves.toEqual(fixture.inventory);
      expect(calls[0]?.statement).toContain("platform.load_model_option_inventory");
      expect(calls[0]?.values).toEqual([fixture.inventory.digest]);
    } finally {
      revokePlatformTransaction(lease);
    }
  });

  it("persists materialization through one owner call without provider secrets", async () => {
    const fixture = catalogFixture();
    const calls: { statement: string; values: readonly unknown[] }[] = [];
    const receipt = {
      materializationId: "00000000-0000-4000-8000-000000000021",
      artifactDigest: "a".repeat(64),
      inventoryDigest: fixture.inventory.digest,
      materializationDigest: "b".repeat(64),
      optionRevisionRefs: [fixture.option.modelOptionRevisionRef],
      quarantineCount: 0,
      replayed: false,
    } as const;
    const lease = issuePlatformTransaction({
      query: async <Row extends Record<string, unknown>>(statement: string, values = []) => {
        calls.push({ statement, values });
        return [receipt] as unknown as readonly Row[];
      },
      execute: async () => 0,
    });
    try {
      await expect(
        new PostgresProductModelOptionRepository().materializeLegacyOptions(lease.transaction, {
          materializationId: receipt.materializationId,
          materializedBy: "operator-a",
          materialization: {
            schemaVersion: 1,
            compilerVersion: "model-option-compiler.v1",
            artifactDigest: receipt.artifactDigest,
            inventoryDigest: receipt.inventoryDigest,
            materializationDigest: receipt.materializationDigest,
            optionRevisions: [fixture.option],
            quarantine: [],
          },
        }),
      ).resolves.toEqual(receipt);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.statement).toContain("platform.materialize_legacy_model_options");
      expect(JSON.stringify(calls)).not.toMatch(/secret:\/\/provider-a/u);
    } finally {
      revokePlatformTransaction(lease);
    }
  });

  it("rejects a materialization receipt that does not attest the submitted facts", async () => {
    const fixture = catalogFixture();
    const lease = issuePlatformTransaction({
      query: async <Row extends Record<string, unknown>>() => [{
        materializationId: "00000000-0000-4000-8000-000000000023",
        artifactDigest: "c".repeat(64),
        inventoryDigest: fixture.inventory.digest,
        materializationDigest: "b".repeat(64),
        optionRevisionRefs: [fixture.option.modelOptionRevisionRef],
        quarantineCount: 0,
        replayed: false,
      }] as unknown as readonly Row[],
      execute: async () => 0,
    });
    try {
      await expect(
        new PostgresProductModelOptionRepository().materializeLegacyOptions(lease.transaction, {
          materializationId: "00000000-0000-4000-8000-000000000023",
          materializedBy: "operator-a",
          materialization: {
            schemaVersion: 1,
            compilerVersion: "model-option-compiler.v1",
            artifactDigest: "a".repeat(64),
            inventoryDigest: fixture.inventory.digest,
            materializationDigest: "b".repeat(64),
            optionRevisions: [fixture.option],
            quarantine: [],
          },
        }),
      ).rejects.toThrow("MODEL_OPTION_MATERIALIZATION_RECEIPT_INVALID");
    } finally {
      revokePlatformTransaction(lease);
    }
  });

  it("loads requested immutable revisions and rejects tampered payloads", async () => {
    const fixture = catalogFixture();
    const lease = issuePlatformTransaction({
      query: async <Row extends Record<string, unknown>>() =>
        [{ revisionPayload: { ...fixture.option, label: "tampered" } }] as unknown as readonly Row[],
      execute: async () => 0,
    });
    try {
      await expect(
        new PostgresProductModelOptionRepository().loadOptionRevisions(
          lease.transaction,
          [fixture.option.modelOptionRevisionRef],
        ),
      ).rejects.toThrow("MODEL_OPTION_REVISION_DIGEST_MISMATCH");
    } finally {
      revokePlatformTransaction(lease);
    }
  });

  it("publishes the complete immutable release projection through one owner call", async () => {
    const fixture = catalogFixture();
    const receipt = {
      publicationId: "00000000-0000-4000-8000-000000000022",
      siteId: fixture.release.siteId,
      siteReleaseRef: fixture.release.siteReleaseRef,
      modelOptionCatalogRef: fixture.release.modelOptionCatalogRef,
      catalogDigest: fixture.release.catalogDigest,
      replayed: false,
    } as const;
    const calls: { statement: string; values: readonly unknown[] }[] = [];
    const lease = issuePlatformTransaction({
      query: async <Row extends Record<string, unknown>>(statement: string, values = []) => {
        calls.push({ statement, values });
        return [receipt] as unknown as readonly Row[];
      },
      execute: async () => 0,
    });
    try {
      await expect(
        new PostgresProductModelOptionRepository().publishSiteReleaseCatalog(lease.transaction, {
          publicationId: receipt.publicationId,
          publishedBy: "operator-a",
          catalog: fixture.release,
        }),
      ).resolves.toEqual(receipt);
      expect(calls[0]?.statement).toContain("platform.publish_site_release_model_catalog");
      expect(calls[0]?.values).toEqual([
        receipt.publicationId,
        JSON.stringify(fixture.release),
        "operator-a",
      ]);
    } finally {
      revokePlatformTransaction(lease);
    }
  });

  it("loads an exact SiteRelease snapshot through the safe owner function", async () => {
    const fixture = catalogFixture();
    const calls: { statement: string; values: readonly unknown[] }[] = [];
    const lease = issuePlatformTransaction({
      query: async <Row extends Record<string, unknown>>(
        statement: string,
        values: readonly unknown[] = [],
      ) => {
        calls.push({ statement, values });
        return [
          {
            releasePayload: fixture.release,
            optionRevisionPayloads: [fixture.option],
            runtimeAvailableModelKeys: ["chat-primary"],
          },
        ] as unknown as readonly Row[];
      },
      execute: async () => 0,
    });
    try {
      const snapshot = await new PostgresProductModelOptionRepository().loadProductCatalogSnapshot(
        lease.transaction,
        { siteId: "site-a", siteReleaseRef: "release-a" },
      );
      expect(snapshot).toEqual({
        release: fixture.release,
        optionRevisions: [fixture.option],
        runtimeAvailableModelKeys: ["chat-primary"],
      });
      expect(calls).toHaveLength(1);
      expect(calls[0]?.statement).toContain("platform.resolve_product_model_option_catalog");
      expect(calls[0]?.values).toEqual(["site-a", "release-a"]);
      expect(JSON.stringify(calls)).not.toMatch(/secret|provider/u);
    } finally {
      revokePlatformTransaction(lease);
    }
  });

  it("rejects owner output whose immutable option payload was tampered", async () => {
    const fixture = catalogFixture();
    const tampered = { ...fixture.option, label: "Tampered" };
    const lease = issuePlatformTransaction({
      query: async <Row extends Record<string, unknown>>() =>
        [{
          releasePayload: fixture.release,
          optionRevisionPayloads: [tampered],
          runtimeAvailableModelKeys: ["chat-primary"],
        }] as unknown as readonly Row[],
      execute: async () => 0,
    });
    try {
      await expect(
        new PostgresProductModelOptionRepository().loadProductCatalogSnapshot(
          lease.transaction,
          { siteId: "site-a", siteReleaseRef: "release-a" },
        ),
      ).rejects.toThrow("MODEL_OPTION_REVISION_DIGEST_MISMATCH");
    } finally {
      revokePlatformTransaction(lease);
    }
  });
});

describe("transaction-scoped ProductContext catalog adapter", () => {
  it("uses the caller transaction and never opens a nested unit of work", async () => {
    const fixture = catalogFixture();
    const transaction = {} as Parameters<ModelOptionCatalogRepository["loadProductCatalogSnapshot"]>[0];
    let observed: unknown;
    const repository = repositoryDouble({
      loadProductCatalogSnapshot: async (candidate) => {
        observed = candidate;
        return {
          release: fixture.release,
          optionRevisions: [fixture.option],
          runtimeAvailableModelKeys: ["chat-primary"],
        };
      },
    });
    const context = {
      trustedCaller: { kind: "site_product", siteId: "site-a" },
      target: { siteId: "site-a" },
    } as VerifiedRequestSecurityContext;
    const result = await new PostgresProductModelOptionCatalogReader(repository).readForProductContext(
      { siteId: "site-a", siteReleaseRef: "release-a" },
      context,
      transaction,
    );
    expect(observed).toBe(transaction);
    expect(result.modelOptionCatalogs[0]?.options[0]?.availability).toBe("available");
    expect(JSON.stringify(result)).not.toMatch(/provider|route|fallback|primaryModel/u);
  });
});

function catalogFixture() {
  const inventory = canonicalizeModelInventory({
    schemaVersion: 1,
    source: { kind: "platform-native", reference: "postgres-test" },
    providers: [{
      key: "provider-a", provider: "openai-compatible", accountKey: "primary",
      secretRef: "secret://provider-a", adapterKind: "litellm", priority: 0,
    }],
    models: [{
      key: "chat-primary", displayName: "Chat", inputModalities: ["text"],
      outputModalities: ["text"], capabilities: ["chat"], contextWindow: null, enabled: true,
    }],
    bindings: [{
      key: "binding:chat-primary", modelKey: "chat-primary", providerKey: "provider-a",
      upstreamModel: "chat-primary", gatewayModelName: "chat-primary", priority: 0, enabled: true,
    }],
    productRoutes: [{
      product: "chat", role: "main", modelKey: "chat-primary", position: 0,
      requiredCapabilities: ["chat"],
    }],
  });
  const option = compileModelOptionRevision({
    inventory,
    option: {
      legacyLabelId: "legacy-chat", key: "chat.standard", product: "chat",
      displayName: "Standard", description: null, tier: "standard",
      defaultModelKey: "chat-primary", candidateModelKeys: ["chat-primary"], enabled: true,
    },
  });
  const release = createSiteReleaseModelCatalogRevision({
    siteId: "site-a", siteReleaseRef: "release-a", inventoryDigest: inventory.digest,
    publishedAt: "2026-07-29T12:00:00.000Z",
    surfaces: [{
      surfaceId: "chat", allowedModelOptionRevisionRefs: [option.modelOptionRevisionRef],
      defaultModelOptionRevisionRef: option.modelOptionRevisionRef,
    }],
    optionRevisions: [option],
  });
  return { inventory, option, release };
}

function repositoryDouble(
  overrides: Partial<ModelOptionCatalogRepository>,
): ModelOptionCatalogRepository {
  return {
    loadInventory: async () => null,
    materializeLegacyOptions: async () => { throw new Error("unused"); },
    loadOptionRevisions: async () => [],
    publishSiteReleaseCatalog: async () => { throw new Error("unused"); },
    loadProductCatalogSnapshot: async () => null,
    ...overrides,
  };
}
