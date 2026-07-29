import { describe, expect, it } from "vitest";
import { ReportModelProviderAvailabilityService } from "../../src/modules/model-control/application/services/report-model-provider-availability.js";
import type { ModelControlRepository } from "../../src/modules/model-control/application/contracts/model-control-ports.js";
import { verifyRequestSecurityContext } from "../../src/shared/security-context/request-security-context.js";
import {
  PlatformUnitOfWork,
  type PlatformTransactionHost,
} from "../../src/shared/unit-of-work/index.js";
import {
  issuePlatformTransaction,
  revokePlatformTransaction,
} from "../../src/shared/unit-of-work/platform-transaction.js";

describe("model provider operational availability", () => {
  it("reports a canonical observation through the Worker-only UoW command", async () => {
    const operations: string[] = [];
    let reported: Parameters<ModelControlRepository["reportProviderAvailability"]>[1] | null = null;
    const repository = unusedRepository({
      reportProviderAvailability: async (_transaction, input) => {
        reported = input;
        return {
          reportId: input.reportId,
          providerKey: input.providerKey,
          appliedEpoch: "8",
          replayed: false,
        };
      },
    });
    const service = new ReportModelProviderAvailabilityService(unitOfWork(operations), repository);

    await expect(
      service.report(
        {
          reportId: "00000000-0000-4000-8000-000000000008",
          providerKey: "provider-a",
          status: "active",
          health: "degraded",
          expectedEpoch: "7",
          observationRef: "probe:provider-a:7",
          observedAt: "2026-07-28T08:01:02-04:00",
        },
        await workerContext(),
      ),
    ).resolves.toEqual({
      reportId: "00000000-0000-4000-8000-000000000008",
      providerKey: "provider-a",
      appliedEpoch: "8",
      replayed: false,
    });
    expect(operations).toEqual(["model.availability.report"]);
    expect(reported).toMatchObject({
      expectedEpoch: "7",
      observedAt: "2026-07-28T12:01:02.000Z",
      reportedBy: "worker:model-health",
    });
  });
});

function unusedRepository(
  override: Pick<ModelControlRepository, "reportProviderAvailability">,
): ModelControlRepository {
  const unused = async (): Promise<never> => {
    throw new Error("unused");
  };
  return {
    importInventory: unused,
    activateInventory: unused,
    putSitePolicy: unused,
    loadCandidates: unused,
    findSelectionDecision: unused,
    recordSelectionDecision: unused,
    ...override,
  };
}

function unitOfWork(operations: string[]): PlatformUnitOfWork {
  const host: PlatformTransactionHost = {
    transaction: async (fence, work) => {
      operations.push(fence.operation);
      const lease = issuePlatformTransaction({ query: async () => [], execute: async () => 0 });
      try {
        return await work(lease.transaction);
      } finally {
        revokePlatformTransaction(lease);
      }
    },
  };
  return new PlatformUnitOfWork(host, () => "2026-07-28T12:01:30.000Z");
}

async function workerContext() {
  const caller = {
    workloadIdentityId: "model-health-worker",
    kind: "platform_worker" as const,
    siteId: null,
    audience: "platform-internal",
    environment: "production",
    region: "us-east-1",
    allowedOperations: ["model.availability.report"],
    bindingEpoch: "1",
    issuedAt: "2026-07-28T12:00:00.000Z",
    expiresAt: "2026-07-28T12:10:00.000Z",
    issuer: "spiffe://model-health-worker",
    keyVersion: "ca-1",
  };
  return verifyRequestSecurityContext(
    {
      requestId: "req-health",
      correlationId: "corr-health",
      trustedCaller: {
        workloadIdentityId: caller.workloadIdentityId,
        kind: caller.kind,
        environment: caller.environment,
        region: caller.region,
        audience: caller.audience,
        allowedOperations: caller.allowedOperations,
        bindingEpoch: caller.bindingEpoch,
        issuedAt: caller.issuedAt,
        expiresAt: caller.expiresAt,
      },
      actor: {
        kind: "workload",
        subjectId: "worker:model-health",
        subjectGeneration: "1",
      },
      delegatedGrant: null,
      target: {
        siteId: null,
        workspaceId: null,
        projectId: null,
        purpose: "model_health_observation",
        scopes: ["model:availability:write"],
      },
      audience: caller.audience,
      environment: caller.environment,
      region: caller.region,
      evidence: [{ kind: "workload_attestation", evidenceId: "ev", issuer: caller.issuer }],
      policyEpoch: "1",
      issuedAt: "2026-07-28T12:00:00.000Z",
      expiresAt: "2026-07-28T12:05:00.000Z",
    },
    {
      now: "2026-07-28T12:00:30.000Z",
      operation: "model.availability.report",
      expectedAudience: caller.audience,
      expectedEnvironment: caller.environment,
      expectedRegion: caller.region,
      callerVerifier: { verify: async () => caller },
    },
  );
}
