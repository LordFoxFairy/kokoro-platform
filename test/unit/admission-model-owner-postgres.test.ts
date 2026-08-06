import { describe, expect, it } from "vitest";
import { canonicalizeModelInventory } from "../../src/modules/model-control/domain/model-catalog.js";
import {
  compileModelOptionRevision,
  createSiteReleaseModelCatalogRevision,
} from "../../src/modules/model-control/domain/product-model-option.js";
import { PostgresAdmissionModelOwner } from "../../src/modules/admission/infrastructure/postgres/admission-model-owner.js";
import type { AdmissionModelCatalogRepository } from "../../src/modules/model-control/application/contracts/product-model-option-ports.js";
import type { PlatformTransaction } from "../../src/shared/unit-of-work/index.js";

const transaction = Object.freeze({}) as PlatformTransaction;

describe("Postgres Admission Model owner", () => {
  it("uses the published option orchestration order and deterministic healthy binding", async () => {
    const fixture = modelFixture();
    const owner = new PostgresAdmissionModelOwner(repository({
      siteId: "site-a",
      siteReleaseRef: "release-a",
      inventoryDigest: fixture.inventory.digest,
      optionRevision: fixture.option,
      runtimeCandidates: [
        {
          modelKey: "chat-fallback", modelPosition: 1, bindingKey: "binding:z",
          bindingPriority: 1, providerPriority: 1, adapterKind: "direct",
          provider: "anthropic", upstreamModel: "claude-direct", gatewayModelName: "unused",
        },
        {
          modelKey: "chat-fallback", modelPosition: 1, bindingKey: "binding:a",
          bindingPriority: 0, providerPriority: 9, adapterKind: "litellm",
          provider: "openai-compatible", upstreamModel: "unused", gatewayModelName: "chat-fallback-gateway",
        },
      ],
    }));

    await expect(owner.resolve(transaction, {
      siteId: "site-a",
      configurationRevisionId: "release-a",
      modelOptionRevisionRef: fixture.option.modelOptionRevisionRef,
      requestedEffort: "medium",
    })).resolves.toEqual({
      kind: "resolved",
      value: {
        provider: "litellm",
        name: "chat-fallback-gateway",
        route: {
          adapterKind: "litellm",
          gatewayModel: "chat-fallback-gateway",
          providerModel: "unused",
        },
        effort: "medium",
        modelLabel: "Standard",
      },
    });
  });

  it("maps a direct provider without exposing account or secret metadata", async () => {
    const fixture = modelFixture();
    const owner = new PostgresAdmissionModelOwner(repository({
      siteId: "site-a",
      siteReleaseRef: "release-a",
      inventoryDigest: fixture.inventory.digest,
      optionRevision: fixture.option,
      runtimeCandidates: [{
        modelKey: "chat-primary", modelPosition: 0, bindingKey: "binding:direct",
        bindingPriority: 0, providerPriority: 0, adapterKind: "direct",
        provider: "anthropic", upstreamModel: "claude-sonnet-4", gatewayModelName: "chat-direct",
      }],
    }));

    const result = await owner.resolve(transaction, {
      siteId: "site-a", configurationRevisionId: "release-a",
      modelOptionRevisionRef: fixture.option.modelOptionRevisionRef,
    });
    expect(result).toEqual({
      kind: "resolved",
      value: {
        provider: "direct",
        name: "chat-direct",
        route: {
          adapterKind: "direct",
          gatewayModel: "chat-direct",
          providerModel: "claude-sonnet-4",
        },
        modelLabel: "Standard",
      },
    });
    expect(JSON.stringify(result)).not.toMatch(/secret|account|binding|anthropic/u);
  });

  it("denies an unpublished option, unsupported effort, or unavailable runtime", async () => {
    const fixture = modelFixture();
    const missing = new PostgresAdmissionModelOwner(repository(null));
    await expect(missing.resolve(transaction, {
      siteId: "site-a", configurationRevisionId: "release-a",
      modelOptionRevisionRef: fixture.option.modelOptionRevisionRef,
    })).resolves.toMatchObject({
      kind: "denied", denial: { code: "ADMISSION_MODEL_OPTION_NOT_AVAILABLE" },
    });

    const snapshot = {
      siteId: "site-a", siteReleaseRef: "release-a", inventoryDigest: fixture.inventory.digest,
      optionRevision: fixture.option, runtimeCandidates: [],
    } as const;
    const unavailable = new PostgresAdmissionModelOwner(repository(snapshot));
    await expect(unavailable.resolve(transaction, {
      siteId: "site-a", configurationRevisionId: "release-a",
      modelOptionRevisionRef: fixture.option.modelOptionRevisionRef,
      requestedEffort: "high",
    })).resolves.toMatchObject({
      kind: "denied", denial: { code: "ADMISSION_MODEL_EFFORT_NOT_SUPPORTED" },
    });
    await expect(unavailable.resolve(transaction, {
      siteId: "site-a", configurationRevisionId: "release-a",
      modelOptionRevisionRef: fixture.option.modelOptionRevisionRef,
    })).resolves.toMatchObject({
      kind: "denied", denial: { code: "ADMISSION_MODEL_RUNTIME_UNAVAILABLE" },
    });
  });

  it("raises a hard corruption error when owner facts escape the immutable release", async () => {
    const fixture = modelFixture();
    const owner = new PostgresAdmissionModelOwner(repository({
      siteId: "other-site", siteReleaseRef: "release-a", inventoryDigest: fixture.inventory.digest,
      optionRevision: fixture.option, runtimeCandidates: [],
    }));
    await expect(owner.resolve(transaction, {
      siteId: "site-a", configurationRevisionId: "release-a",
      modelOptionRevisionRef: fixture.option.modelOptionRevisionRef,
    })).rejects.toThrow("ADMISSION_MODEL_OWNER_CORRUPT");
  });
});

function repository(
  snapshot: Awaited<ReturnType<AdmissionModelCatalogRepository["loadAdmissionModelSnapshot"]>>,
): AdmissionModelCatalogRepository {
  return { loadAdmissionModelSnapshot: async () => snapshot };
}

function modelFixture() {
  const inventory = canonicalizeModelInventory({
    schemaVersion: 1,
    source: { kind: "platform-native", reference: "admission-test" },
    providers: [{
      key: "provider-a", provider: "openai-compatible", accountKey: "primary",
      secretRef: "secret://provider-a", adapterKind: "litellm", priority: 0,
    }],
    models: [
      {
        key: "chat-primary", displayName: "Primary", inputModalities: ["text"],
        outputModalities: ["text"], capabilities: ["chat", "effort.medium"],
        contextWindow: null, enabled: true,
      },
      {
        key: "chat-fallback", displayName: "Fallback", inputModalities: ["text"],
        outputModalities: ["text"], capabilities: ["chat", "effort.medium"],
        contextWindow: null, enabled: true,
      },
    ],
    bindings: [
      {
        key: "binding:primary", modelKey: "chat-primary", providerKey: "provider-a",
        upstreamModel: "primary", gatewayModelName: "chat-primary", priority: 0, enabled: true,
      },
      {
        key: "binding:fallback", modelKey: "chat-fallback", providerKey: "provider-a",
        upstreamModel: "fallback", gatewayModelName: "chat-fallback", priority: 0, enabled: true,
      },
    ],
    productRoutes: [
      { product: "chat", role: "main", modelKey: "chat-primary", position: 0, requiredCapabilities: ["chat"] },
      { product: "chat", role: "main", modelKey: "chat-fallback", position: 1, requiredCapabilities: ["chat"] },
    ],
  });
  const option = compileModelOptionRevision({
    inventory,
    draft: {
      schemaVersion: 1, optionKey: "chat.standard", surface: "chat", label: "Standard",
      description: null, tier: "standard", lifecycle: "active",
      composition: {
        orchestration: { primaryModelKey: "chat-primary", fallbackModelKeys: ["chat-fallback"] },
        generation: { primaryModelKey: "chat-primary", fallbackModelKeys: ["chat-fallback"] },
      },
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
