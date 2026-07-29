import { beforeAll, describe, expect, it } from "vitest";
import { MaterializeLegacyModelOptionsService } from "../../src/modules/model-control/application/services/materialize-legacy-model-options.js";
import { PublishSiteReleaseModelCatalogService } from "../../src/modules/model-control/application/services/publish-site-release-model-catalog.js";
import { ReadProductModelOptionCatalogsService } from "../../src/modules/model-control/application/services/read-product-model-option-catalogs.js";
import type {
  ModelOptionCatalogRepository,
  ModelOptionMaterializationReceipt,
} from "../../src/modules/model-control/application/contracts/product-model-option-ports.js";
import type { ModelControlCommandJournal } from "../../src/modules/model-control/application/contracts/model-control-command-journal.js";
import { canonicalizeModelInventory } from "../../src/modules/model-control/domain/model-catalog.js";
import { compileModelOptionRevision, createSiteReleaseModelCatalogRevision } from "../../src/modules/model-control/domain/product-model-option.js";
import { createLegacyModelOptionMigrationArtifact } from "../../src/modules/model-control/migration/legacy-model-option-artifact.js";
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
    admin = await context("admin_workload", null, ["model.option.migration.materialize"]);
    publishAdmin = await context(
      "admin_workload",
      "site-a",
      ["model.site-release-catalog.publish"],
      "site_release",
    );
    product = await context("site_product", "site-a", ["model.option-catalog.read"]);
  });

  it("materializes legacy options, receipt, and outbox through one caller-owned transaction", async () => {
    const inventory = catalog();
    const artifact = createLegacyModelOptionMigrationArtifact({
      labels: [
        {
          legacyLabelId: "label-chat",
          key: "chat.standard",
          displayName: "Standard",
          description: null,
          featureKey: "chat",
          tier: "standard",
          defaultBindingId: "chat-primary",
          status: "active",
        },
      ],
      bindings: [
        {
          legacyBindingId: "chat-primary",
          modelKey: "chat-primary",
          labelKeys: ["chat.standard"],
          priority: 0,
        },
      ],
      referencedLabelKeys: [],
    });
    const calls: { kind: string; transaction: PlatformTransaction }[] = [];
    const receipt: ModelOptionMaterializationReceipt = {
      materializationId: "00000000-0000-4000-8000-000000000011",
      artifactDigest: artifact.artifactDigest,
      inventoryDigest: inventory.digest,
      materializationDigest: "b".repeat(64),
      optionRevisionRefs: [],
      quarantineCount: 0,
      replayed: false,
    };
    const repository = repositoryDouble({
      loadInventory: async (transaction) => {
        calls.push({ kind: "load", transaction });
        return inventory;
      },
      materializeLegacyOptions: async (transaction, input) => {
        calls.push({ kind: "materialize", transaction });
        return {
          ...receipt,
          materializationDigest: input.materialization.materializationDigest,
          optionRevisionRefs: input.materialization.optionRevisions.map(
            ({ modelOptionRevisionRef }) => modelOptionRevisionRef,
          ),
        };
      },
    });
    const journal = journalDouble(calls);
    const result = await new MaterializeLegacyModelOptionsService(
      unitOfWork(),
      repository,
      journal,
    ).materialize(
      {
        materializationId: receipt.materializationId,
        inventoryDigest: inventory.digest,
        artifact,
      },
      admin,
    );

    expect(result.optionRevisionRefs).toHaveLength(1);
    expect(calls.map(({ kind }) => kind)).toEqual([
      "journal.begin",
      "load",
      "materialize",
      "journal.succeed",
    ]);
    expect(new Set(calls.map(({ transaction }) => transaction)).size).toBe(1);
  });

  it("publishes an immutable exact-Site release catalog through the same journal", async () => {
    const inventory = catalog();
    const revision = compileModelOptionRevision({
      inventory,
      option: {
        legacyLabelId: "label-chat",
        key: "chat.standard",
        product: "chat",
        displayName: "Standard",
        description: null,
        tier: "standard",
        defaultModelKey: "chat-primary",
        candidateModelKeys: ["chat-primary"],
        enabled: true,
      },
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
          replayed: false,
        };
      },
    });
    const result = await new PublishSiteReleaseModelCatalogService(
      unitOfWork(),
      repository,
      journalDouble(calls),
    ).publish(
      {
        publicationId: "00000000-0000-4000-8000-000000000012",
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

  it("returns a safe ProductContext projection and rejects cross-Site reads", async () => {
    const inventory = catalog();
    const revision = compileModelOptionRevision({
      inventory,
      option: {
        legacyLabelId: "label-chat",
        key: "chat.standard",
        product: "chat",
        displayName: "Standard",
        description: null,
        tier: "standard",
        defaultModelKey: "chat-primary",
        candidateModelKeys: ["chat-primary"],
        enabled: true,
      },
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
    materializeLegacyOptions: async () => {
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
  purpose = kind === "admin_workload" ? "model_control_migration" : "product_context",
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
