import { beforeAll, describe, expect, it } from "vitest";
import {
  canonicalizeModelInventory,
  type CanonicalModelInventory,
} from "../../src/modules/model-control/domain/model-catalog.js";
import { ResolveModelPolicyService } from "../../src/modules/model-control/application/services/resolve-model-policy.js";
import { canonicalizeSiteModelPolicy } from "../../src/modules/model-control/domain/site-model-policy.js";
import type { ModelControlRepository } from "../../src/modules/model-control/application/contracts/model-control-ports.js";
import {
  verifyRequestSecurityContext,
  type VerifiedRequestSecurityContext,
} from "../../src/shared/security-context/request-security-context.js";
import {
  PlatformUnitOfWork,
  type PlatformTransactionHost,
} from "../../src/shared/unit-of-work/index.js";
import {
  issuePlatformTransaction,
  revokePlatformTransaction,
} from "../../src/shared/unit-of-work/platform-transaction.js";

const inventory: CanonicalModelInventory = {
  schemaVersion: 1,
  source: { kind: "legacy-kokoro-model", reference: "snapshot-1" },
  providers: [
    {
      key: "provider-b",
      provider: "openai-compatible",
      accountKey: "b",
      secretRef: "secret://b",
      adapterKind: "direct",
      priority: 20,
    },
    {
      key: "provider-a",
      provider: "openai-compatible",
      accountKey: "a",
      secretRef: "secret://a",
      adapterKind: "litellm",
      priority: 10,
    },
  ],
  models: [
    {
      key: "chat-fast",
      displayName: "Fast",
      inputModalities: ["text"],
      outputModalities: ["text"],
      capabilities: ["chat", "streaming"],
      contextWindow: 128000,
      enabled: true,
    },
    {
      key: "chat-safe",
      displayName: "Safe",
      inputModalities: ["text"],
      outputModalities: ["text"],
      capabilities: ["chat", "streaming"],
      contextWindow: 64000,
      enabled: true,
    },
    {
      key: "music-gen",
      displayName: "Music",
      inputModalities: ["text"],
      outputModalities: ["audio"],
      capabilities: ["music.generate"],
      contextWindow: null,
      enabled: true,
    },
    {
      key: "image-gen",
      displayName: "Image",
      inputModalities: ["text"],
      outputModalities: ["image"],
      capabilities: ["image.generate"],
      contextWindow: null,
      enabled: true,
    },
    {
      key: "video-gen",
      displayName: "Video",
      inputModalities: ["text", "image"],
      outputModalities: ["video"],
      capabilities: ["video.generate"],
      contextWindow: null,
      enabled: true,
    },
  ],
  bindings: [
    {
      key: "bind-chat-fast",
      modelKey: "chat-fast",
      providerKey: "provider-a",
      upstreamModel: "chat-fast",
      gatewayModelName: "openai/chat-fast",
      priority: 0,
      enabled: true,
    },
    {
      key: "bind-chat-safe",
      modelKey: "chat-safe",
      providerKey: "provider-b",
      upstreamModel: "chat-safe",
      gatewayModelName: "chat-safe",
      priority: 0,
      enabled: true,
    },
    {
      key: "bind-music",
      modelKey: "music-gen",
      providerKey: "provider-b",
      upstreamModel: "music",
      gatewayModelName: "music",
      priority: 0,
      enabled: true,
    },
    {
      key: "bind-image",
      modelKey: "image-gen",
      providerKey: "provider-b",
      upstreamModel: "image",
      gatewayModelName: "image",
      priority: 0,
      enabled: true,
    },
    {
      key: "bind-video",
      modelKey: "video-gen",
      providerKey: "provider-b",
      upstreamModel: "video",
      gatewayModelName: "video",
      priority: 0,
      enabled: true,
    },
  ],
  productRoutes: [
    {
      product: "chat",
      role: "main",
      modelKey: "chat-fast",
      position: 0,
      requiredCapabilities: ["chat"],
    },
    {
      product: "chat",
      role: "main",
      modelKey: "chat-safe",
      position: 1,
      requiredCapabilities: ["chat"],
    },
    {
      product: "music",
      role: "main",
      modelKey: "chat-safe",
      position: 0,
      requiredCapabilities: ["chat"],
    },
    {
      product: "music",
      role: "generation",
      modelKey: "music-gen",
      position: 0,
      requiredCapabilities: ["music.generate"],
    },
    {
      product: "image",
      role: "main",
      modelKey: "chat-safe",
      position: 0,
      requiredCapabilities: ["chat"],
    },
    {
      product: "image",
      role: "generation",
      modelKey: "image-gen",
      position: 0,
      requiredCapabilities: ["image.generate"],
    },
    {
      product: "video",
      role: "main",
      modelKey: "chat-safe",
      position: 0,
      requiredCapabilities: ["chat"],
    },
    {
      product: "video",
      role: "generation",
      modelKey: "video-gen",
      position: 0,
      requiredCapabilities: ["video.generate"],
    },
  ],
};

describe("canonical ModelControl", () => {
  let context: VerifiedRequestSecurityContext;
  beforeAll(async () => {
    context = await verifiedContext();
  });

  it("produces one repeatable digest independent of input ordering", () => {
    const first = canonicalizeModelInventory(inventory);
    const second = canonicalizeModelInventory({
      ...inventory,
      providers: [...inventory.providers].reverse(),
      models: [...inventory.models].reverse(),
      productRoutes: [...inventory.productRoutes].reverse(),
    });
    expect(first.digest).toBe(second.digest);
    expect(first.document.providers.map((item) => item.key)).toEqual(["provider-a", "provider-b"]);
    expect(first.counts).toEqual({
      providers: 2,
      models: 5,
      bindings: 5,
      productRoutes: 8,
    });
  });

  it("rejects unknown fields at every canonical catalog object boundary", () => {
    expect(() =>
      canonicalizeModelInventory({ ...inventory, claims: { admin: true } } as never),
    ).toThrowError("MODEL_INVENTORY_SCHEMA_UNKNOWN_FIELD");
    expect(() =>
      canonicalizeModelInventory({
        ...inventory,
        source: { ...inventory.source, siteId: "site-a" },
      } as never),
    ).toThrowError("MODEL_INVENTORY_SOURCE_SCHEMA_UNKNOWN_FIELD");
    expect(() =>
      canonicalizeModelInventory({
        ...inventory,
        providers: [{ ...inventory.providers[0]!, rawSecret: "plaintext" }],
      } as never),
    ).toThrowError("MODEL_PROVIDER_SCHEMA_UNKNOWN_FIELD");
    expect(() =>
      canonicalizeModelInventory({
        ...inventory,
        models: [{ ...inventory.models[0]!, siteId: "site-a" }],
      } as never),
    ).toThrowError("MODEL_DEFINITION_SCHEMA_UNKNOWN_FIELD");
    expect(() =>
      canonicalizeModelInventory({
        ...inventory,
        bindings: [{ ...inventory.bindings[0]!, claims: ["admin"] }],
      } as never),
    ).toThrowError("MODEL_BINDING_SCHEMA_UNKNOWN_FIELD");
    expect(() =>
      canonicalizeModelInventory({
        ...inventory,
        productRoutes: [{ ...inventory.productRoutes[0]!, rawSecret: "plaintext" }],
      } as never),
    ).toThrowError("MODEL_ROUTE_SCHEMA_UNKNOWN_FIELD");
  });

  it("requires route completeness only for products present in the published route set", () => {
    const chatOnly = canonicalizeModelInventory({
      ...inventory,
      models: inventory.models.filter((model) => model.capabilities.includes("chat")),
      bindings: inventory.bindings.filter((binding) => binding.modelKey.startsWith("chat-")),
      productRoutes: inventory.productRoutes.filter((route) => route.product === "chat"),
    });
    expect(new Set(chatOnly.document.productRoutes.map((route) => route.product))).toEqual(
      new Set(["chat"]),
    );
    expect(() =>
      canonicalizeModelInventory({
        ...chatOnly.document,
        productRoutes: [
          ...chatOnly.document.productRoutes,
          {
            product: "image",
            role: "main",
            modelKey: "chat-safe",
            position: 0,
            requiredCapabilities: ["chat"],
          },
        ],
      }),
    ).toThrowError("MODEL_PRODUCT_GENERATION_REQUIRED:image");
  });

  it("keeps Site policy outside the global catalog and pins replacement assignments", () => {
    const catalog = canonicalizeModelInventory(inventory);
    expect(catalog.document).not.toHaveProperty("sitePolicies");
    expect(() =>
      canonicalizeSiteModelPolicy({
        schemaVersion: 1,
        siteId: "site-a",
        product: "chat",
        enabled: true,
        catalog: { mode: "follow_active", digest: null },
        assignmentMode: "replace",
        assignments: [],
      }),
    ).toThrowError("MODEL_SITE_REPLACE_REQUIRES_PINNED_CATALOG");
  });

  it("selects an auditable deterministic fallback without calling a provider", async () => {
    const decisions: unknown[] = [];
    const repository: ModelControlRepository = {
      importInventory: async () => {
        throw new Error("unused");
      },
      activateInventory: async () => {
        throw new Error("unused");
      },
      putSitePolicy: async () => {
        throw new Error("unused");
      },
      reportProviderAvailability: async () => {
        throw new Error("unused");
      },
      findSelectionDecision: async () => null,
      loadCandidates: async () => ({
        inventoryDigest: "a".repeat(64),
        policyStatus: "enabled",
        policyRevision: "1",
        candidates: [candidate("chat-fast", "down", 0), candidate("chat-safe", "healthy", 1)],
      }),
      recordSelectionDecision: async (_tx, decision) => {
        decisions.push(decision);
        return decision;
      },
    };
    const service = new ResolveModelPolicyService(
      unitOfWork(),
      repository,
      () => "2026-07-28T12:01:00.000Z",
    );
    const result = await service.resolve(
      {
        siteId: "site-a",
        product: "chat",
        role: "main",
        requiredCapabilities: ["chat"],
        decisionId: "00000000-0000-4000-8000-000000000001",
      },
      context,
    );
    expect(result).toMatchObject({
      kind: "selected",
      selected: { modelKey: "chat-safe" },
      reason: "fallback_after_provider_down",
    });
    expect(decisions).toHaveLength(1);
  });

  it("recomputes the policy-input digest and rejects decision replay with different capabilities", async () => {
    let recorded: Parameters<ModelControlRepository["recordSelectionDecision"]>[1] | null = null;
    const repository: ModelControlRepository = {
      importInventory: async () => {
        throw new Error("unused");
      },
      activateInventory: async () => {
        throw new Error("unused");
      },
      putSitePolicy: async () => {
        throw new Error("unused");
      },
      reportProviderAvailability: async () => {
        throw new Error("unused");
      },
      findSelectionDecision: async () => recorded,
      loadCandidates: async () => ({
        inventoryDigest: "a".repeat(64),
        policyStatus: "enabled",
        policyRevision: "1",
        candidates: [candidate("chat-fast", "healthy", 0)],
      }),
      recordSelectionDecision: async (_transaction, decision) => {
        recorded = decision;
        return decision;
      },
    };
    const service = new ResolveModelPolicyService(
      unitOfWork(),
      repository,
      () => "2026-07-28T12:01:00.000Z",
    );
    const base = {
      siteId: "site-a",
      product: "chat" as const,
      role: "main" as const,
      decisionId: "00000000-0000-4000-8000-000000000002",
    };
    await service.resolve({ ...base, requiredCapabilities: ["chat"] }, context);
    await expect(
      service.resolve({ ...base, requiredCapabilities: ["streaming"] }, context),
    ).rejects.toThrowError("MODEL_SELECTION_DECISION_CONFLICT");
  });

  it("returns the persisted winner when the same decision races", async () => {
    const repository: ModelControlRepository = {
      importInventory: async () => {
        throw new Error("unused");
      },
      activateInventory: async () => {
        throw new Error("unused");
      },
      putSitePolicy: async () => {
        throw new Error("unused");
      },
      reportProviderAvailability: async () => {
        throw new Error("unused");
      },
      findSelectionDecision: async () => null,
      loadCandidates: async () => ({
        inventoryDigest: "a".repeat(64),
        policyStatus: "enabled",
        policyRevision: "1",
        candidates: [candidate("chat-fast", "healthy", 0)],
      }),
      recordSelectionDecision: async (_transaction, proposal) => ({
        ...proposal,
        reason: "persisted_concurrent_winner",
      }),
    };
    const result = await new ResolveModelPolicyService(
      unitOfWork(),
      repository,
      () => "2026-07-28T12:01:00.000Z",
    ).resolve(
      {
        siteId: "site-a",
        product: "chat",
        role: "main",
        requiredCapabilities: ["chat"],
        decisionId: "00000000-0000-4000-8000-000000000003",
      },
      context,
    );
    expect(result.reason).toBe("persisted_concurrent_winner");
  });

  it("rejects down providers while keeping an explicit unknown cold-start policy", async () => {
    const repository: ModelControlRepository = {
      importInventory: async () => {
        throw new Error("unused");
      },
      activateInventory: async () => {
        throw new Error("unused");
      },
      putSitePolicy: async () => {
        throw new Error("unused");
      },
      reportProviderAvailability: async () => {
        throw new Error("unused");
      },
      findSelectionDecision: async () => null,
      loadCandidates: async () => ({
        inventoryDigest: "a".repeat(64),
        policyStatus: "enabled",
        policyRevision: "1",
        candidates: [candidate("chat-down", "down", 0), candidate("chat-unknown", "unknown", 1)],
      }),
      recordSelectionDecision: async (_transaction, decision) => decision,
    };
    const result = await new ResolveModelPolicyService(
      unitOfWork(),
      repository,
      () => "2026-07-28T12:01:00.000Z",
    ).resolve(
      {
        siteId: "site-a",
        product: "chat",
        role: "main",
        requiredCapabilities: ["chat"],
        decisionId: "00000000-0000-4000-8000-000000000004",
      },
      context,
    );
    expect(result).toMatchObject({
      kind: "selected",
      selected: { modelKey: "chat-unknown" },
      reason: "fallback_after_provider_down",
    });
  });
});

function candidate(modelKey: string, health: "healthy" | "unknown" | "down", position: number) {
  return {
    modelKey,
    bindingKey: `binding-${modelKey}`,
    providerKey: `provider-${modelKey}`,
    gatewayModelName: modelKey,
    executionBoundary: "model_gateway" as const,
    position,
    bindingPriority: 0,
    providerPriority: 0,
    inputModalities: ["text"],
    outputModalities: ["text"],
    capabilities: ["chat"],
    contextWindow: 64000,
    providerStatus: "active" as const,
    providerHealth: health,
    modelStatus: "active" as const,
    bindingStatus: "active" as const,
    routeRequiredCapabilities: ["chat"],
  };
}
function unitOfWork() {
  const host: PlatformTransactionHost = {
    transaction: async (_fence, work) => {
      const lease = issuePlatformTransaction({ query: async () => [], execute: async () => 0 });
      try {
        return await work(lease.transaction);
      } finally {
        revokePlatformTransaction(lease);
      }
    },
  };
  return new PlatformUnitOfWork(host, () => "2026-07-28T12:01:00.000Z");
}
async function verifiedContext() {
  return verifyRequestSecurityContext(
    {
      requestId: "req",
      correlationId: "corr",
      trustedCaller: {
        kind: "site_product",
        workloadIdentityId: "web-a",
        siteId: "site-a",
        environment: "production",
        region: "us-east-1",
        audience: "platform-public",
        allowedOperations: ["model.policy.resolve"],
        bindingEpoch: "1",
        issuedAt: "2026-07-28T12:00:00.000Z",
        expiresAt: "2026-07-28T12:10:00.000Z",
      },
      actor: {
        kind: "user",
        subjectId: "user-a",
        subjectGeneration: "1",
        sessionId: "session-a",
        assuranceLevel: "password",
        sessionEpoch: "1",
        restrictionEpoch: "1",
      },
      delegatedGrant: null,
      target: {
        siteId: "site-a",
        workspaceId: null,
        projectId: null,
        purpose: "model_resolution",
        scopes: ["model:read"],
      },
      audience: "platform-public",
      environment: "production",
      region: "us-east-1",
      evidence: [{ kind: "workload_attestation", evidenceId: "ev", issuer: "spiffe://web-a" }],
      policyEpoch: "1",
      issuedAt: "2026-07-28T12:00:00.000Z",
      expiresAt: "2026-07-28T12:05:00.000Z",
    },
    {
      now: "2026-07-28T12:00:30.000Z",
      operation: "model.policy.resolve",
      expectedAudience: "platform-public",
      expectedEnvironment: "production",
      expectedRegion: "us-east-1",
      callerVerifier: {
        verify: async () => ({
          workloadIdentityId: "web-a",
          kind: "site_product",
          siteId: "site-a",
          audience: "platform-public",
          environment: "production",
          region: "us-east-1",
          allowedOperations: ["model.policy.resolve"],
          bindingEpoch: "1",
          issuedAt: "2026-07-28T12:00:00.000Z",
          expiresAt: "2026-07-28T12:10:00.000Z",
          issuer: "spiffe://web-a",
          keyVersion: "ca-1",
        }),
      },
    },
  );
}
