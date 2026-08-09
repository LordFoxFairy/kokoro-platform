import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { ImportModelControlService } from
  "../../src/modules/model-control/application/services/import-model-control.js";
import { PostgresAdmissionModelOwner } from
  "../../src/modules/admission/infrastructure/postgres/admission-model-owner.js";
import { ResolveModelPolicyService } from
  "../../src/modules/model-control/application/services/resolve-model-policy.js";
import { ReportModelProviderAvailabilityService } from
  "../../src/modules/model-control/application/services/report-model-provider-availability.js";
import type { ModelControlCommandJournal } from
  "../../src/modules/model-control/application/contracts/model-control-command-journal.js";
import type { ModelControlRepository } from
  "../../src/modules/model-control/application/contracts/model-control-ports.js";
import type { CanonicalModelInventory } from
  "../../src/modules/model-control/domain/model-catalog.js";
import { DIRECT_MODEL_PROVIDER_IDENTITY } from
  "../../src/modules/model-control/domain/direct-model-provider-identity.js";
import { classifyModelControlError } from
  "../../src/modules/model-control/interfaces/connect/model-control-error-policy.js";
import { verifyRequestSecurityContext } from
  "../../src/shared/security-context/request-security-context.js";
import {
  PlatformUnitOfWork,
  type PlatformTransaction,
  type PlatformTransactionHost,
} from "../../src/shared/unit-of-work/index.js";

const directIdentity = DIRECT_MODEL_PROVIDER_IDENTITY;

describe("configured Direct model provider identity", () => {
  it("rejects an imported Direct provider that does not own the configured identity", async () => {
    const repository = repositoryDouble();
    const service = importService(repository);
    const verified = await context("model.inventory.import");

    expect(() => service.import({
      importId: "00000000-0000-4000-8000-000000000101",
      requestDigest: "a".repeat(64),
      inventory: inventory({ providerKey: "operator-chosen", accountKey: "other" }),
    }, verified)).toThrow(
      "MODEL_DIRECT_PROVIDER_IDENTITY_MISMATCH",
    );
    expect(repository.importInventory).not.toHaveBeenCalled();
  });

  it("rejects a fake Direct provider label outside the Gateway protocol", async () => {
    const repository = repositoryDouble();
    const service = importService(repository);
    const verified = await context("model.inventory.import");
    const candidate = inventory(directIdentity);

    expect(() => service.import({
      importId: "00000000-0000-4000-8000-000000000106",
      requestDigest: "f".repeat(64),
      inventory: {
        ...candidate,
        providers: [{ ...candidate.providers[0]!, provider: "anthropic" }],
      },
    }, verified)).toThrow("MODEL_DIRECT_PROVIDER_IDENTITY_MISMATCH");
    expect(repository.importInventory).not.toHaveBeenCalled();
    expect(classifyModelControlError(
      new Error("MODEL_DIRECT_PROVIDER_IDENTITY_MISMATCH"),
    )).toBe("invalidRequest");
  });

  it("keeps multiple upstream bindings behind the one Direct credential", async () => {
    const repository = repositoryDouble();
    const candidate = inventory(directIdentity);

    await importService(repository).import({
      importId: "00000000-0000-4000-8000-000000000107",
      requestDigest: "1".repeat(64),
      inventory: {
        ...candidate,
        bindings: [
          ...candidate.bindings,
          {
            ...candidate.bindings[0]!,
            key: "binding:chat-secondary",
            upstreamModel: "provider-chat-v2",
            gatewayModelName: "chat-secondary",
            priority: 1,
          },
        ],
      },
      providerAvailability: [],
    }, await context("model.inventory.import"));

    expect(repository.importInventory).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        inventory: expect.objectContaining({ counts: expect.objectContaining({ bindings: 2 }) }),
      }),
    );
  });

  it("cold-starts only Direct when Admin submits an empty mixed-provider availability", async () => {
    const repository = repositoryDouble();
    let availability:
      Parameters<ModelControlRepository["importInventory"]>[1]["providerAvailability"] = [];
    vi.mocked(repository.importInventory).mockImplementation(async (_transaction, input) => {
      availability = input.providerAvailability;
      return {
        importId: input.importId,
        digest: input.inventory.digest,
        replayed: false,
        counts: input.inventory.counts,
      };
    });
    vi.mocked(repository.reportProviderAvailability).mockImplementation(
      async (_transaction, input) => {
        const current = availability.find((item) => item.providerKey === input.providerKey);
        if (current?.epoch !== input.expectedEpoch) throw new Error("unexpected epoch");
        availability = availability.map((item) => item.providerKey === input.providerKey ? {
          providerKey: item.providerKey,
          status: input.status,
          health: input.health,
          epoch: "1",
          observationRef: input.observationRef,
          observedAt: input.observedAt,
        } : item);
        return {
          reportId: input.reportId,
          providerKey: input.providerKey,
          appliedEpoch: "1",
          replayed: false,
        };
      },
    );
    const service = importService(repository);

    await service.import({
      importId: "00000000-0000-4000-8000-000000000102",
      requestDigest: "b".repeat(64),
      inventory: mixedInventory(),
      providerAvailability: [],
    }, await context("model.inventory.import"));

    expect(repository.importInventory).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      providerAvailability: [
        {
          providerKey: directIdentity.providerKey,
          status: "active",
          health: "unknown",
          epoch: "0",
          observationRef: null,
          observedAt: null,
        },
        {
          providerKey: "litellm-explicit",
          status: "disabled",
          health: "unknown",
          epoch: "0",
          observationRef: null,
          observedAt: null,
        },
      ],
    }));

    await new ReportModelProviderAvailabilityService(unitOfWork(), repository).report({
      reportId: "00000000-0000-4000-8000-000000000104",
      providerKey: "litellm-explicit",
      status: "active",
      health: "unknown",
      expectedEpoch: "0",
      observationRef: null,
      observedAt: null,
    }, await context("model.availability.report"));

    const selectionRepository: ModelControlRepository = {
      ...repository,
      findSelectionDecision: vi.fn(async () => null),
      loadCandidates: vi.fn(async () => ({
        inventoryDigest: "c".repeat(64),
        policyStatus: "enabled" as const,
        policyRevision: "1",
        candidates: availability.map((providerAvailability) => ({
          modelKey: "chat-primary",
          bindingKey: providerAvailability.providerKey === directIdentity.providerKey ?
            "binding:direct" : "binding:litellm",
          providerKey: providerAvailability.providerKey,
          adapterKind: providerAvailability.providerKey === directIdentity.providerKey ?
            "direct" as const : "litellm" as const,
          gatewayModelName: "chat-primary",
          executionBoundary: "model_gateway" as const,
          position: 0,
          bindingPriority: providerAvailability.providerKey === directIdentity.providerKey ? 1 : 0,
          providerPriority: 0,
          inputModalities: ["text"],
          outputModalities: ["text"],
          capabilities: ["chat"],
          contextWindow: null,
          providerStatus: providerAvailability.status,
          providerHealth: providerAvailability.health,
          modelStatus: "active" as const,
          bindingStatus: "active" as const,
          routeRequiredCapabilities: ["chat"],
        })),
      })),
      recordSelectionDecision: vi.fn(async (_transaction, decision) => decision),
    };
    await expect(new ResolveModelPolicyService(
      unitOfWork(), selectionRepository, () => "2026-08-09T12:00:00.000Z",
    ).resolve({
      decisionId: "00000000-0000-4000-8000-000000000103",
      siteId: "site-a",
      product: "chat",
      role: "main",
      requiredCapabilities: ["chat"],
    }, await context("model.policy.resolve", "site-a"))).resolves.toMatchObject({
      kind: "selected",
      selected: { modelKey: "chat-primary", bindingKey: "binding:direct" },
      reason: "fallback_after_provider_unknown",
    });
  });

  it("keeps cold-start unknown eligible in both production catalog and Admission projections", () => {
    for (const migration of [
      "../../prisma/migrations/20260729_product_model_options/migration.sql",
      "../../prisma/migrations/20260731_admission_model_owner/migration.sql",
    ]) {
      const source = readFileSync(new URL(migration, import.meta.url), "utf8");
      expect(source).toContain(
        "(provider_availability.health IN ('healthy','degraded') OR " +
        "(provider.adapter_kind='direct' AND provider_availability.health='unknown'))",
      );
      expect(source).not.toContain(
        "provider_availability.health IN ('unknown','healthy','degraded')",
      );
    }
  });

  it("enforces the Direct identity and runtime-managed secret marker in PostgreSQL import and activation", () => {
    const migration = readFileSync(new URL(
      "../../prisma/migrations/0003_model_control/migration.sql",
      import.meta.url,
    ), "utf8");
    expect(migration).not.toContain("p_direct_provider_key");
    expect(migration).toContain("item->>'key'='direct'");
    expect(migration).toContain("item->>'accountKey'='primary'");
    expect(migration).toContain("item->>'provider'='openai-compatible'");
    expect(migration).toContain("'secret://platform/model-gateway/direct'");
    expect(migration.match(/MODEL_DIRECT_PROVIDER_IDENTITY_MISMATCH/gu)).toHaveLength(2);
    expect(migration).toContain("provider.adapter_kind<>'direct' THEN 'disabled'");
    expect(migration).toContain("(adapter_kind='direct') = (");
  });

  it("does not expose the canonical Direct identity as a constructor or composition option", () => {
    expect(ImportModelControlService.length).toBe(3);
    expect(PostgresAdmissionModelOwner.length).toBe(0);
    for (const sourcePath of [
      "../../src/modules/model-control/application/services/import-model-control.ts",
      "../../src/modules/admission/infrastructure/postgres/admission-model-owner.ts",
      "../../src/process/model-option-admin-composition.ts",
      "../../src/process/admission-composition.ts",
    ]) {
      const source = readFileSync(new URL(sourcePath, import.meta.url), "utf8");
      expect(source).not.toContain("directProviderIdentity");
    }
  });
});

function importService(repository: ModelControlRepository): ImportModelControlService {
  return new ImportModelControlService(unitOfWork(), repository, journal());
}

function inventory(identity: Readonly<{ providerKey: string; accountKey: string }>): CanonicalModelInventory {
  return {
    schemaVersion: 1,
    source: { kind: "platform-native", reference: "direct-mvp-test" },
    providers: [{
      key: identity.providerKey,
      provider: "openai-compatible",
      accountKey: identity.accountKey,
      secretRef: "secret://platform/model-gateway/direct",
      adapterKind: "direct",
      priority: 0,
    }],
    models: [{
      key: "chat-primary",
      displayName: "Chat",
      inputModalities: ["text"],
      outputModalities: ["text"],
      capabilities: ["chat"],
      contextWindow: null,
      enabled: true,
    }],
    bindings: [{
      key: "binding:chat-primary",
      modelKey: "chat-primary",
      providerKey: identity.providerKey,
      upstreamModel: "provider-chat-v1",
      gatewayModelName: "chat-primary",
      priority: 0,
      enabled: true,
    }],
    productRoutes: [{
      product: "chat",
      role: "main",
      modelKey: "chat-primary",
      position: 0,
      requiredCapabilities: ["chat"],
    }],
  };
}

function mixedInventory(): CanonicalModelInventory {
  const direct = inventory(directIdentity);
  return {
    ...direct,
    providers: [
      ...direct.providers,
      {
        key: "litellm-explicit",
        provider: "openai-compatible",
        accountKey: "litellm",
        secretRef: "secret://platform/model-gateway/litellm",
        adapterKind: "litellm",
        priority: 0,
      },
    ],
    bindings: [
      { ...direct.bindings[0]!, key: "binding:direct", priority: 1 },
      {
        ...direct.bindings[0]!,
        key: "binding:litellm",
        providerKey: "litellm-explicit",
        gatewayModelName: "chat-primary-litellm",
        priority: 0,
      },
    ],
  };
}

function repositoryDouble(): ModelControlRepository {
  return {
    importInventory: vi.fn(async (_transaction, input) => ({
      importId: input.importId,
      digest: input.inventory.digest,
      replayed: false,
      counts: input.inventory.counts,
    })),
    activateInventory: vi.fn(async () => { throw new Error("unexpected activation"); }),
    putSitePolicy: vi.fn(async () => { throw new Error("unexpected policy"); }),
    reportProviderAvailability: vi.fn(async () => { throw new Error("unexpected report"); }),
    loadCandidates: vi.fn(async () => { throw new Error("unexpected candidates"); }),
    findSelectionDecision: vi.fn(async () => null),
    recordSelectionDecision: vi.fn(async (_transaction, decision) => decision),
  };
}

function journal(): ModelControlCommandJournal {
  return { begin: async () => undefined, succeed: async () => undefined };
}

function unitOfWork(): PlatformUnitOfWork {
  const host: PlatformTransactionHost = {
    transaction: async (_fence, work) => work({} as PlatformTransaction),
  };
  return new PlatformUnitOfWork(host, () => "2026-08-09T12:00:00.000Z");
}

async function context(operation: string, siteId: string | null = null) {
  const availabilityReport = operation === "model.availability.report";
  const input = {
    requestId: "request-direct-mvp",
    correlationId: "correlation-direct-mvp",
    trustedCaller: {
      kind: availabilityReport ? "platform_worker" as const : "admin_workload" as const,
      workloadIdentityId: "spiffe://kokoro/web-admin",
      environment: "production",
      region: "us-east-1",
      audience: "platform",
      allowedOperations: [operation],
      bindingEpoch: "1",
      issuedAt: "2026-08-09T11:59:00.000Z",
      expiresAt: "2026-08-09T12:05:00.000Z",
    },
    actor: availabilityReport ?
      { kind: "workload" as const, subjectId: "model-health:1", subjectGeneration: "1" } :
      { kind: "operator" as const, subjectId: "operator:1", subjectGeneration: "1" },
    delegatedGrant: null,
    target: {
      siteId,
      workspaceId: null,
      projectId: null,
      purpose: availabilityReport ? "model_health_observation" : "model_control_administration",
      scopes: operation === "model.inventory.import" ? ["model:inventory:import"] :
        availabilityReport ? ["model:availability:write"] : [],
    },
    audience: "platform",
    environment: "production",
    region: "us-east-1",
    evidence: [{ kind: "signature", evidenceId: "evidence-1", issuer: "issuer-a" }],
    policyEpoch: "1",
    issuedAt: "2026-08-09T11:59:00.000Z",
    expiresAt: "2026-08-09T12:05:00.000Z",
  };
  return verifyRequestSecurityContext(input, {
    now: "2026-08-09T12:00:00.000Z",
    operation,
    expectedAudience: "platform",
    expectedEnvironment: "production",
    expectedRegion: "us-east-1",
    callerVerifier: {
      verify: async () => ({
        workloadIdentityId: input.trustedCaller.workloadIdentityId,
        kind: input.trustedCaller.kind,
        audience: input.trustedCaller.audience,
        environment: input.trustedCaller.environment,
        region: input.trustedCaller.region,
        allowedOperations: input.trustedCaller.allowedOperations,
        siteId: null,
        bindingEpoch: input.trustedCaller.bindingEpoch,
        issuedAt: input.trustedCaller.issuedAt,
        expiresAt: input.trustedCaller.expiresAt,
        issuer: "issuer-a",
        keyVersion: "key-1",
      }),
    },
  });
}
