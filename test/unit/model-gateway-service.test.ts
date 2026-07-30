import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ModelGatewayService,
  type ModelGatewayInvocationRecord,
  type ModelGatewayRepository,
  type ModelGatewayUnitOfWork,
  type ModelInvocationAuthorization,
  type PreparedModelProviderRequest,
} from "../../src/modules/model-gateway/application/model-gateway-service.js";

const authorization: ModelInvocationAuthorization = Object.freeze({
  modelAuthorizationHandle: `model-authorization:sha256:${"f".repeat(64)}`,
  siteId: "site-a",
  executionManifestRef: "execution-manifest:sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  authorizationSegmentRef: "segment-a",
  authorizedGatewayModel: "chat-primary",
  expiresAt: "2030-01-01T00:00:00.000Z",
});

describe("ModelGatewayService", () => {
  it("durably prepares usage before provider I/O and finalizes measured usage", async () => {
    const events: string[] = [];
    const repository = new MemoryRepository(events);
    const provider = providerAdapter(events, {
      kind: "succeeded",
      responseBody: bytes({ id: "provider-response", choices: [{ message: { content: "hello" } }] }),
      usage: [{ dimensionKey: "input_tokens", sourceUnit: "tokens", quantity: 12n },
        { dimensionKey: "output_tokens", sourceUnit: "tokens", quantity: 4n }],
      sourceDigest: digest(bytes({ id: "provider-response", choices: [{ message: { content: "hello" } }] })),
      occurredAt: "2029-01-01T00:00:01.000Z",
    });
    const usage = usageOwner(events);
    const service = createService({ repository, provider, usage });

    const result = await service.invoke(invocation());

    expect(result).toMatchObject({
      kind: "succeeded",
      invocationRef: "invocation-1",
      attemptRef: "attempt-1",
      replayed: false,
    });
    expect(events).toEqual([
      "uow:prepare",
      "usage:prepare",
      "repository:prepared",
      "provider:invoke",
      "uow:finalize",
      "usage:finalize:measured",
      "repository:terminal",
    ]);
    expect(repository.record?.state).toBe("succeeded");
    expect(repository.record?.fenceEpoch).toBe(2n);
  });

  it("never calls a provider when the usage owner rejects prepare", async () => {
    const events: string[] = [];
    const provider = providerAdapter(events, successfulProviderOutcome());
    const usage = usageOwner(events, { prepareKind: "invalid_state" });
    const service = createService({ repository: new MemoryRepository(events), provider, usage });

    await expect(service.invoke(invocation())).rejects.toThrowError(
      "MODEL_GATEWAY_USAGE_PREPARE_INVALID_STATE",
    );
    expect(events).toEqual(["uow:prepare", "usage:prepare"]);
  });

  it("records an ambiguous provider timeout as outcome_unknown and never invents zero usage", async () => {
    const events: string[] = [];
    const repository = new MemoryRepository(events);
    const usage = usageOwner(events);
    const service = createService({
      repository,
      usage,
      provider: providerAdapter(events, {
        kind: "outcome_unknown",
        ownerEvidenceRef: "provider-timeout:sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      }),
    });

    const result = await service.invoke(invocation());

    expect(result).toMatchObject({ kind: "outcome_unknown", replayed: false });
    expect(events).toEqual([
      "uow:prepare",
      "usage:prepare",
      "repository:prepared",
      "provider:invoke",
      "uow:unknown",
      "usage:unknown",
      "repository:unknown",
    ]);
    expect(events).not.toContain("usage:finalize:zero");
    expect(repository.record?.state).toBe("outcome_unknown");
  });

  it("persists terminal unavailable evidence instead of treating missing provider usage as zero", async () => {
    const events: string[] = [];
    const usage = usageOwner(events);
    const service = createService({
      repository: new MemoryRepository(events),
      usage,
      provider: providerAdapter(events, {
        kind: "succeeded",
        responseBody: bytes({ id: "provider-response", choices: [] }),
        usage: null,
        sourceDigest: digest(bytes({ id: "provider-response", choices: [] })),
        occurredAt: "2029-01-01T00:00:01.000Z",
      }),
    });

    await expect(service.invoke(invocation())).resolves.toMatchObject({ kind: "succeeded" });
    expect(events).toContain("usage:finalize:unavailable");
    expect(events).not.toContain("usage:finalize:zero");
  });

  it("replays one durable result without a second provider effect and rejects a changed digest", async () => {
    const events: string[] = [];
    const repository = new MemoryRepository(events);
    const service = createService({
      repository,
      usage: usageOwner(events),
      provider: providerAdapter(events, successfulProviderOutcome()),
    });
    await service.invoke(invocation());
    events.length = 0;

    const replay = await service.invoke(invocation());
    expect(replay).toMatchObject({ kind: "succeeded", replayed: true });
    expect(events).toEqual(["uow:prepare"]);

    await expect(service.invoke(invocation({ request: { ...request(), maxOutputTokens: 64 } })))
      .rejects.toThrowError("MODEL_GATEWAY_INVOCATION_DIGEST_CONFLICT");
    expect(events).toEqual(["uow:prepare", "uow:prepare"]);
  });

  it("turns an exact retry of an abandoned dispatch into durable unknown without redispatch", async () => {
    const events: string[] = [];
    const repository = new MemoryRepository(events);
    const provider = providerAdapter(events, successfulProviderOutcome());
    const prepared = provider.prepare(request());
    repository.record = {
      siteId: authorization.siteId,
      invocationRef: "invocation-abandoned",
      modelAuthorizationHandle: authorization.modelAuthorizationHandle,
      executionManifestRef: authorization.executionManifestRef,
      authorizationSegmentRef: authorization.authorizationSegmentRef,
      logicalCallRef: "logical-call-1",
      attemptRef: "attempt-1",
      producerContext: "ga-run-1",
      producerGeneration: 1n,
      requestDigest: prepared.requestDigest,
      gatewayModel: prepared.gatewayModel,
      maximumDimensions: prepared.maximumDimensions,
      attemptAuthorizationRef: "attempt-authorization-1",
      fenceEpoch: 1n,
      state: "dispatching",
      responseBody: null,
      usageEvidence: null,
      evidenceRef: null,
      sourceDigest: null,
      ownerEvidenceRef: null,
      createdAt: "2028-01-01T00:00:00.000Z",
      updatedAt: "2028-01-01T00:00:00.000Z",
    };
    const service = createService({ repository, provider, usage: usageOwner(events) });

    await expect(service.invoke(invocation())).resolves.toMatchObject({
      kind: "outcome_unknown", replayed: false,
    });
    expect(events).toEqual(["uow:prepare", "uow:unknown", "usage:unknown", "repository:unknown"]);
    expect(events).not.toContain("provider:invoke");
  });

  it("rejects a requested model outside the opaque manifest authorization before effect", async () => {
    const events: string[] = [];
    const service = createService({
      repository: new MemoryRepository(events),
      usage: usageOwner(events),
      provider: providerAdapter(events, successfulProviderOutcome()),
    });

    await expect(service.invoke(invocation({ request: { ...request(), model: "not-authorized" } })))
      .rejects.toThrowError("MODEL_GATEWAY_ROUTE_NOT_AUTHORIZED");
    expect(events).toEqual(["uow:prepare"]);
  });

  it("still records terminal provider truth when authorization expires after the effect started", async () => {
    const events: string[] = [];
    let clockReads = 0;
    const service = createService({
      repository: new MemoryRepository(events),
      usage: usageOwner(events),
      provider: providerAdapter(events, successfulProviderOutcome()),
      clock: () => new Date(clockReads++ === 0
        ? "2029-01-01T00:00:00.000Z"
        : "2031-01-01T00:00:00.000Z"),
    });

    await expect(service.invoke(invocation())).resolves.toMatchObject({ kind: "succeeded" });
    expect(events).toContain("usage:finalize:measured");
  });

  it("reconciles an unknown outcome through the same fenced attempt receipt", async () => {
    const events: string[] = [];
    const repository = new MemoryRepository(events);
    const service = createService({
      repository,
      usage: usageOwner(events),
      provider: providerAdapter(events, {
        kind: "outcome_unknown",
        ownerEvidenceRef: `provider-timeout:sha256:${"b".repeat(64)}`,
      }),
    });
    await service.invoke(invocation());
    events.length = 0;

    const result = await service.reconcileOutcome({
      modelAuthorizationHandle: authorization.modelAuthorizationHandle,
      logicalCallRef: "logical-call-1",
      requestDigest: repository.record?.requestDigest ?? "",
      outcome: successfulProviderOutcome(),
    });

    expect(result).toMatchObject({ kind: "succeeded", invocationRef: "invocation-1" });
    expect(events).toEqual([
      "uow:finalize",
      "uow:finalize",
      "usage:finalize:measured",
      "repository:terminal",
    ]);
    expect(repository.record?.attemptAuthorizationRef).toBe("attempt-authorization-1");
    expect(repository.record?.fenceEpoch).toBe(3n);
  });
});

function createService(input: Readonly<{
  repository: ModelGatewayRepository;
  provider: ReturnType<typeof providerAdapter>;
  usage: ReturnType<typeof usageOwner>;
  clock?: () => Date;
}>) {
  return new ModelGatewayService({
    unitOfWork: unitOfWork((input.repository as MemoryRepository).events),
    repository: input.repository,
    provider: input.provider,
    usageOwner: input.usage,
    reference: (kind) => kind === "invocation" ? "invocation-1" :
      kind === "evidence" ? "evidence-1" : "outbox-1",
    clock: input.clock ?? (() => new Date("2029-01-01T00:00:00.000Z")),
  });
}

function invocation(overrides: Partial<Parameters<ModelGatewayService["invoke"]>[0]> = {}) {
  return {
    modelAuthorizationHandle: authorization.modelAuthorizationHandle,
    logicalCallRef: "logical-call-1",
    attemptRef: "attempt-1",
    producerContext: "ga-run-1",
    producerGeneration: 1n,
    request: request(),
    signal: AbortSignal.timeout(5_000),
    ...overrides,
  };
}

function request() {
  return {
    protocol: "openai.chat.completions.v1" as const,
    model: "chat-primary",
    messages: [{ role: "user" as const, content: "hello" }],
    maxOutputTokens: 128,
  };
}

function unitOfWork(events: string[]): ModelGatewayUnitOfWork {
  return {
    execute: async (scope, work) => {
      expect(scope).toMatchObject({
        modelAuthorizationHandle: authorization.modelAuthorizationHandle,
      });
      expect(scope).not.toHaveProperty("executionManifestRef");
      expect(scope).not.toHaveProperty("authorizationSegmentRef");
      events.push(`uow:${scope.operation}`);
      return work({} as never, authorization);
    },
  };
}

class MemoryRepository implements ModelGatewayRepository {
  record: ModelGatewayInvocationRecord | null = null;
  constructor(readonly events: string[]) {}

  async lockInvocation(_transaction: never, input: { logicalCallRef: string }) {
    return this.record?.logicalCallRef === input.logicalCallRef ? this.record : null;
  }

  async persistPrepared(_transaction: never, record: ModelGatewayInvocationRecord) {
    this.events.push("repository:prepared");
    this.record = record;
  }

  async persistTerminal(_transaction: never, record: ModelGatewayInvocationRecord) {
    this.events.push("repository:terminal");
    this.record = record;
  }

  async persistOutcomeUnknown(_transaction: never, record: ModelGatewayInvocationRecord) {
    this.events.push("repository:unknown");
    this.record = record;
  }
}

function providerAdapter(events: string[], outcome: Awaited<ReturnType<PreparedModelProviderRequest["invoke"]>>) {
  return {
    prepare(requested: ReturnType<typeof request>): PreparedModelProviderRequest {
      const body = bytes(requested);
      return {
        gatewayModel: requested.model,
        requestDigest: digest(body),
        maximumDimensions: [
          { dimensionKey: "input_tokens", sourceUnit: "tokens", quantity: BigInt(body.byteLength) },
          { dimensionKey: "output_tokens", sourceUnit: "tokens", quantity: BigInt(requested.maxOutputTokens) },
        ],
        invoke: async () => {
          events.push("provider:invoke");
          return outcome;
        },
      };
    },
  };
}

function usageOwner(events: string[], options: { prepareKind?: "invalid_state" } = {}) {
  return {
    async prepareAttempt() {
      events.push("usage:prepare");
      if (options.prepareKind !== undefined) {
        return { kind: options.prepareKind, code: "CREDIT_USAGE_ATTEMPT_CAPACITY_EXCEEDED" } as const;
      }
      return { kind: "accepted", value: {
        attemptAuthorizationRef: "attempt-authorization-1",
        state: "effect_committed",
        fenceEpoch: 1n,
      } } as const;
    },
    async finalizeAttempt(_transaction: never, input: { evidence: { evidenceKind: string } }) {
      events.push(`usage:finalize:${input.evidence.evidenceKind}`);
      return { kind: "accepted", value: { evidenceRef: "evidence-1", revision: 1n } } as const;
    },
    async markAttemptOutcomeUnknown() {
      events.push("usage:unknown");
      return { kind: "accepted", value: {
        attemptAuthorizationRef: "attempt-authorization-1",
        state: "outcome_unknown",
        fenceEpoch: 2n,
      } } as const;
    },
  };
}

function successfulProviderOutcome() {
  return {
    kind: "succeeded" as const,
    responseBody: bytes({ id: "provider-response", choices: [] }),
    usage: [{ dimensionKey: "input_tokens", sourceUnit: "tokens", quantity: 1n },
      { dimensionKey: "output_tokens", sourceUnit: "tokens", quantity: 1n }],
    sourceDigest: digest(bytes({ id: "provider-response", choices: [] })),
    occurredAt: "2029-01-01T00:00:01.000Z",
  };
}

function bytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(typeof value === "string" ? value : JSON.stringify(value));
}

function digest(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
