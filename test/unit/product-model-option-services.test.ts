import { beforeAll, describe, expect, it } from "vitest";
import { MaterializeModelOptionsService } from "../../src/modules/model-control/application/services/materialize-model-options.js";
import { PublishSiteReleaseModelCatalogService } from "../../src/modules/model-control/application/services/publish-site-release-model-catalog.js";
import { ReadProductModelOptionCatalogsService } from "../../src/modules/model-control/application/services/read-product-model-option-catalogs.js";
import type { ModelOptionCatalogRepository } from "../../src/modules/model-control/application/contracts/product-model-option-ports.js";
import type { ModelControlCommandJournal } from "../../src/modules/model-control/application/contracts/model-control-command-journal.js";
import { canonicalizeModelInventory } from "../../src/modules/model-control/domain/model-catalog.js";
import { compileModelOptionRevision, createSiteReleaseModelCatalogRevision } from "../../src/modules/model-control/domain/product-model-option.js";
import {
  PlatformUnitOfWork,
  type PlatformTransaction,
  type PlatformTransactionHost,
} from "../../src/shared/unit-of-work/index.js";
import {
  verifyRequestSecurityContext,
  type VerifiedRequestSecurityContext,
} from "../../src/shared/security-context/request-security-context.js";

describe("Product ModelOption application services", () => {
  let admin: VerifiedRequestSecurityContext;
  let publishAdmin: VerifiedRequestSecurityContext;
  let product: VerifiedRequestSecurityContext;
  beforeAll(async () => {
    admin = await context("admin_workload", null, ["model.option.materialize"]);
    publishAdmin = await context(
      "admin_workload",
      "site-a",
      ["model.site-release-catalog.publish"],
      "site_release",
    );
    product = await context("site_product", "site-a", ["model.option-catalog.read"]);
  });

  it("materializes native options, receipt, and outbox through one caller-owned transaction", async () => {
    const inventory = catalog();
    const calls: { kind: string; transaction: PlatformTransaction }[] = [];
    const materializationId = "00000000-0000-4000-8000-000000000011";
    const repository = repositoryDouble({
      loadInventory: async (transaction) => {
        calls.push({ kind: "load", transaction });
        return inventory;
      },
      materializeOptions: async (transaction, input) => {
        calls.push({ kind: "materialize", transaction });
        return {
          materializationId,
          sourceDigest: input.materialization.sourceDigest,
          inventoryDigest: input.materialization.inventoryDigest,
          materializationDigest: input.materialization.materializationDigest,
          optionRevisionRefs: input.materialization.optionRevisions.map(
            ({ modelOptionRevisionRef }) => modelOptionRevisionRef,
          ),
          replayed: false,
        };
      },
    });
    const journal = journalDouble(calls);
    const result = await new MaterializeModelOptionsService(
      unitOfWork(),
      repository,
      journal,
    ).materialize(
      {
        materializationId,
        requestDigest: "1".repeat(64),
        inventoryDigest: inventory.digest,
        options: [chatDraft()],
      },
      admin,
    );

    expect(result.optionRevisionRefs).toHaveLength(1);
    expect(calls.map(({ kind }) => kind)).toEqual([
      "load",
      "journal.begin",
      "materialize",
      "journal.succeed",
    ]);
    expect(new Set(calls.map(({ transaction }) => transaction)).size).toBe(1);
  });

  it("publishes an immutable exact-Site release catalog through the same journal", async () => {
    const inventory = catalog();
    const revision = compileModelOptionRevision({
      inventory,
      draft: chatDraft(),
    });
    const calls: { kind: string; transaction: PlatformTransaction }[] = [];
    const repository = repositoryDouble({
      loadOptionRevisions: async (transaction) => {
        calls.push({ kind: "load-options", transaction });
        return [revision];
      },
      publishSiteReleaseCatalog: async (transaction, input) => {
        calls.push({ kind: "publish", transaction });
        return {
          publicationId: input.publicationId,
          siteId: input.catalog.siteId,
          siteReleaseRef: input.catalog.siteReleaseRef,
          modelOptionCatalogRef: input.catalog.modelOptionCatalogRef,
          catalogDigest: input.catalog.catalogDigest,
          publishedAt: input.catalog.publishedAt,
          replayed: false,
        };
      },
    });
    const result = await new PublishSiteReleaseModelCatalogService(
      unitOfWork(),
      repository,
      journalDouble(calls),
      { now: () => "2026-07-29T12:00:00.000Z" },
    ).publish(
      {
        publicationId: "00000000-0000-4000-8000-000000000012",
        requestDigest: "2".repeat(64),
        siteId: "site-a",
        siteReleaseRef: "release-a",
        inventoryDigest: inventory.digest,
        surfaces: [
          {
            surfaceId: "chat",
            allowedModelOptionRevisionRefs: [revision.modelOptionRevisionRef],
            defaultModelOptionRevisionRef: revision.modelOptionRevisionRef,
          },
        ],
      },
      publishAdmin,
    );

    expect(result).toMatchObject({ siteId: "site-a", siteReleaseRef: "release-a" });
    expect(calls.map(({ kind }) => kind)).toEqual([
      "load-options",
      "journal.begin",
      "publish",
      "journal.succeed",
    ]);
    expect(new Set(calls.map(({ transaction }) => transaction)).size).toBe(1);
  });

  it("accepts the original server timestamp when an exact publication command replays", async () => {
    const inventory = catalog();
    const revision = compileModelOptionRevision({ inventory, draft: chatDraft() });
    const originalPublishedAt = "2026-07-29T12:00:00.000Z";
    const repository = repositoryDouble({
      loadOptionRevisions: async () => [revision],
      publishSiteReleaseCatalog: async (_transaction, input) => ({
        publicationId: input.publicationId,
        siteId: input.catalog.siteId,
        siteReleaseRef: input.catalog.siteReleaseRef,
        modelOptionCatalogRef: input.catalog.modelOptionCatalogRef,
        catalogDigest: input.catalog.catalogDigest,
        publishedAt: originalPublishedAt,
        replayed: true,
      }),
    });
    const result = await new PublishSiteReleaseModelCatalogService(
      unitOfWork(),
      repository,
      journalDouble([]),
      { now: () => "2026-07-29T12:05:00.000Z" },
    ).publish({
      publicationId: "00000000-0000-4000-8000-000000000012",
      requestDigest: "2".repeat(64),
      siteId: "site-a",
      siteReleaseRef: "release-a",
      inventoryDigest: inventory.digest,
      surfaces: [{
        surfaceId: "chat",
        allowedModelOptionRevisionRefs: [revision.modelOptionRevisionRef],
        defaultModelOptionRevisionRef: revision.modelOptionRevisionRef,
      }],
    }, publishAdmin);

    expect(result).toMatchObject({ replayed: true, publishedAt: originalPublishedAt });
  });

  it("returns a safe ProductContext projection and rejects cross-Site reads", async () => {
    const inventory = catalog();
    const revision = compileModelOptionRevision({
      inventory,
      draft: chatDraft(),
    });
    const release = createSiteReleaseModelCatalogRevision({
      siteId: "site-a",
      siteReleaseRef: "release-a",
      inventoryDigest: inventory.digest,
      publishedAt: "2026-07-29T12:00:00.000Z",
      surfaces: [
        {
          surfaceId: "chat",
          allowedModelOptionRevisionRefs: [revision.modelOptionRevisionRef],
          defaultModelOptionRevisionRef: revision.modelOptionRevisionRef,
        },
      ],
      optionRevisions: [revision],
    });
    let reads = 0;
    const service = new ReadProductModelOptionCatalogsService(
      unitOfWork(),
      repositoryDouble({
        loadProductCatalogSnapshot: async () => {
          reads += 1;
          return {
            release,
            optionRevisions: [revision],
            runtimeAvailableModelKeys: ["chat-primary"],
          };
        },
      }),
    );
    const result = await service.readForProductContext(
      { siteId: "site-a", siteReleaseRef: "release-a" },
      product,
    );
    expect(result.modelOptionCatalogs[0]?.options[0]).toEqual({
      modelOptionRevisionRef: revision.modelOptionRevisionRef,
      optionKey: "chat.standard",
      label: "Standard",
      inputModalities: ["text"],
      outputModalities: ["text"],
      supportedEfforts: [],
      badges: ["standard"],
      availability: "available",
    });
    expect(JSON.stringify(result)).not.toMatch(/provider|route|fallback|primaryModel/u);
    await expect(
      service.readForProductContext(
        { siteId: "site-b", siteReleaseRef: "release-a" },
        product,
      ),
    ).rejects.toThrowError("MODEL_OPTION_PRODUCT_CONTEXT_SITE_MISMATCH");
    expect(reads).toBe(1);
  });
});

function repositoryDouble(
  overrides: Partial<ModelOptionCatalogRepository>,
): ModelOptionCatalogRepository {
  return {
    loadInventory: async () => null,
    materializeOptions: async () => {
      throw new Error("unused");
    },
    loadOptionRevisions: async () => [],
    publishSiteReleaseCatalog: async () => {
      throw new Error("unused");
    },
    loadProductCatalogSnapshot: async () => null,
    ...overrides,
  };
}

function journalDouble(
  calls: { kind: string; transaction: PlatformTransaction }[],
): ModelControlCommandJournal {
  return {
    begin: async (transaction) => {
      calls.push({ kind: "journal.begin", transaction });
    },
    succeed: async (transaction) => {
      calls.push({ kind: "journal.succeed", transaction });
    },
  };
}

function unitOfWork() {
  const host: PlatformTransactionHost = {
    transaction: async (_fence, work) =>
      work({} as PlatformTransaction),
  };
  return new PlatformUnitOfWork(host, () => "2026-07-29T12:00:01.000Z");
}

async function context(
  kind: "admin_workload" | "site_product",
  siteId: string | null,
  allowedOperations: string[],
  purpose = kind === "admin_workload" ? "model_control_administration" : "product_context",
) {
  const input = {
    requestId: `request-${kind}`,
    correlationId: `correlation-${kind}`,
    trustedCaller: {
      kind,
      workloadIdentityId: `workload-${kind}`,
      ...(siteId === null ? {} : { siteId }),
      environment: "production",
      region: "us-east-1",
      audience: "platform",
      allowedOperations,
      bindingEpoch: "1",
      ...(kind === "site_product"
        ? { siteReleaseRef: "release-a", siteSecurityEpoch: "1" }
        : {}),
      issuedAt: "2026-07-29T11:59:00.000Z",
      expiresAt: "2026-07-29T12:05:00.000Z",
    },
    actor: {
      kind: kind === "admin_workload" ? "operator" : "anonymous",
      subjectId: kind === "admin_workload" ? "operator-a" : "anonymous-a",
      subjectGeneration: "1",
    },
    delegatedGrant: null,
    target: {
      siteId,
      workspaceId: null,
      projectId: null,
      purpose,
      scopes: kind === "admin_workload" ? ["model:site-release:publish"] : [],
    },
    audience: "platform",
    environment: "production",
    region: "us-east-1",
    evidence: [{ kind: "signature", evidenceId: "evidence-1", issuer: "issuer-a" }],
    policyEpoch: "1",
    issuedAt: "2026-07-29T11:59:00.000Z",
    expiresAt: "2026-07-29T12:05:00.000Z",
  };
  return verifyRequestSecurityContext(input, {
    now: "2026-07-29T12:00:00.000Z",
    operation: allowedOperations[0]!,
    expectedAudience: "platform",
    expectedEnvironment: "production",
    expectedRegion: "us-east-1",
    callerVerifier: {
      verify: async () => ({
        workloadIdentityId: input.trustedCaller.workloadIdentityId,
        kind,
        audience: "platform",
        environment: "production",
        region: "us-east-1",
        allowedOperations,
        siteId,
        ...(kind === "site_product"
          ? { siteReleaseRef: "release-a", siteSecurityEpoch: "1" }
          : {}),
        bindingEpoch: "1",
        issuedAt: "2026-07-29T11:59:00.000Z",
        expiresAt: "2026-07-29T12:05:00.000Z",
        issuer: "issuer-a",
        keyVersion: "key-1",
      }),
    },
  });
}

function catalog() {
  return canonicalizeModelInventory({
    schemaVersion: 1,
    source: { kind: "platform-native", reference: "service-test" },
    providers: [
      {
        key: "provider-a",
        provider: "openai-compatible",
        accountKey: "primary",
        secretRef: "secret://provider-a",
        adapterKind: "litellm",
        priority: 0,
      },
    ],
    models: [
      {
        key: "chat-primary",
        displayName: "Chat",
        inputModalities: ["text"],
        outputModalities: ["text"],
        capabilities: ["chat"],
        contextWindow: 128000,
        enabled: true,
      },
    ],
    bindings: [
      {
        key: "binding:chat-primary",
        modelKey: "chat-primary",
        providerKey: "provider-a",
        upstreamModel: "chat-primary",
        gatewayModelName: "chat-primary",
        priority: 0,
        enabled: true,
      },
    ],
    productRoutes: [
      {
        product: "chat",
        role: "main",
        modelKey: "chat-primary",
        position: 0,
        requiredCapabilities: ["chat"],
      },
    ],
  });
}

function chatDraft() {
  const selection = { primaryModelKey: "chat-primary", fallbackModelKeys: [] } as const;
  return {
    schemaVersion: 1 as const,
    optionKey: "chat.standard",
    surface: "chat" as const,
    label: "Standard",
    description: null,
    tier: "standard",
    lifecycle: "active" as const,
    composition: { orchestration: selection, generation: selection },
  };
}
