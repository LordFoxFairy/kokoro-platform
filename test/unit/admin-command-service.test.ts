import { describe, expect, it } from "vitest";
import type { VerifiedRequestSecurityContext } from "../../src/shared/security-context/index.js";
import type { PlatformTransaction } from "../../src/shared/unit-of-work/index.js";
import type { CommandIdentity, CommandReceipt, JsonValue } from "../../src/shared/outbox-inbox/receipt.js";
import type { OutboxEvent } from "../../src/shared/outbox-inbox/outbox.js";
import {
  AdminCommandService,
  AdminLocalCommandRegistry,
  type AdminDecisionRecord,
  type AdminHandlerResult,
} from "../../src/modules/admin-control/application/admin-command-service.js";
import { defineAdminCommand, type AdminOperatorAuthority } from
  "../../src/modules/admin-control/domain/admin-command.js";

const transaction = Object.freeze({}) as PlatformTransaction;
const commandId = "018f1212-1212-7212-8212-121212121212";
const authority: AdminOperatorAuthority = Object.freeze({
  operatorRef: "operator_01", operatorGeneration: 3n, state: "active",
  permissions: ["site.lifecycle.*", "credit.balance.adjust"], siteScopes: ["site_01"],
  environments: ["production"], regions: ["us-east-1"], authorizationEpoch: 9n,
  expiresAt: "2026-07-28T14:00:00.000Z", breakGlassExpiresAt: null,
});

describe("Admin command application service", () => {
  it("persists an immutable admission and maker approval without executing the dangerous effect", async () => {
    const harness = createHarness({
      definition: defineAdminCommand({ commandId: "site.suspend", permission: "site.lifecycle.suspend",
        effectClass: "dangerous", scopeKind: "site", approvalPolicy: "pre_effect", reasonRequired: true }),
      result: { disposition: "succeeded", result: { impossible: true } },
    });

    const result = await harness.service.submit(submission("site.suspend"));

    expect(result).toMatchObject({ disposition: "pending_approval", commandId });
    expect(harness.executions).toBe(0);
    expect(harness.decisions).toMatchObject([{ allowed: true, operation: "site.suspend",
      operatorGeneration: 3n, authorizationEpoch: 9n, targetSiteRef: "site_01",
      approvalPolicy: "pre_effect", operatorReason: "security incident 1842" }]);
    expect(harness.approvals).toHaveLength(1);
    expect(harness.approvals[0]).toMatchObject({ commandId, payload: { siteRef: "site_01" } });
    expect(harness.receipt?.state).toBe("succeeded");
    expect(harness.events).toMatchObject([{ owner: "admin-control",
      eventType: "admin.command.approval.requested" }]);
  });

  it("executes a normal Platform mutation through its local owner port in the same transaction", async () => {
    const harness = createHarness({
      definition: defineAdminCommand({ commandId: "credit.adjust", permission: "credit.balance.adjust",
        effectClass: "mutation", scopeKind: "site", approvalPolicy: "none", reasonRequired: true }),
      result: { disposition: "succeeded", result: { journalRef: "journal_01" } },
    });

    const result = await harness.service.submit(submission("credit.adjust"));

    expect(result).toEqual({ disposition: "succeeded", commandId,
      result: { journalRef: "journal_01" } });
    expect(harness.executions).toBe(1);
    expect(harness.handlerTransaction).toBe(transaction);
    expect(harness.events[0]?.payload).toMatchObject({
      operation: "credit.adjust", operatorGeneration: "3", authorizationEpoch: "9",
      requestDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
      outcome: { disposition: "succeeded", commandId },
    });
  });

  it("fails closed and durably records a denied authority decision before any handler runs", async () => {
    const harness = createHarness({
      definition: defineAdminCommand({ commandId: "site.suspend", permission: "site.lifecycle.suspend",
        effectClass: "dangerous", scopeKind: "site", approvalPolicy: "pre_effect", reasonRequired: true }),
      authority: { ...authority, permissions: ["credit.read"] },
      result: { disposition: "succeeded", result: null },
    });

    const result = await harness.service.submit(submission("site.suspend"));

    expect(result).toEqual({ disposition: "denied", commandId, code: "ADMIN_PERMISSION_DENIED" });
    expect(harness.executions).toBe(0);
    expect(harness.decisions).toMatchObject([{ allowed: false, reasonCode: "ADMIN_PERMISSION_DENIED",
      effectClass: "dangerous", authorizationEpoch: 9n }]);
    expect(harness.receipt?.state).toBe("failed");
    expect(harness.events).toEqual([]);
  });

  it("audits an idempotency digest conflict without overwriting the first command receipt", async () => {
    const harness = createHarness({
      definition: defineAdminCommand({ commandId: "credit.adjust", permission: "credit.balance.adjust",
        effectClass: "mutation", scopeKind: "site", approvalPolicy: "none", reasonRequired: true }),
      beginError: new Error("COMMAND_DIGEST_CONFLICT"),
      result: { disposition: "succeeded", result: null },
    });

    const result = await harness.service.submit(submission("credit.adjust"));

    expect(result).toEqual({ disposition: "denied", commandId, code: "ADMIN_IDEMPOTENCY_CONFLICT" });
    expect(harness.outcomeWrites).toBe(0);
    expect(harness.authorityLoads).toBe(0);
    expect(harness.decisions).toMatchObject([{ allowed: false,
      reasonCode: "ADMIN_IDEMPOTENCY_CONFLICT", authorizationEpoch: null }]);
  });

  it("restores a terminal receipt without re-authorizing or replaying the effect", async () => {
    const restored: JsonValue = { disposition: "succeeded", commandId, result: { journalRef: "journal_01" } };
    const harness = createHarness({
      definition: defineAdminCommand({ commandId: "credit.adjust", permission: "credit.balance.adjust",
        effectClass: "mutation", scopeKind: "site", approvalPolicy: "none", reasonRequired: true }),
      existing: { state: "succeeded", result: restored },
      result: { disposition: "succeeded", result: null },
    });

    await expect(harness.service.submit(submission("credit.adjust"))).resolves.toEqual(restored);
    expect(harness.authorityLoads).toBe(0);
    expect(harness.executions).toBe(0);
    expect(harness.decisions).toEqual([]);
  });
});

function createHarness(input: Readonly<{
  definition: ReturnType<typeof defineAdminCommand>;
  result: AdminHandlerResult;
  authority?: AdminOperatorAuthority;
  beginError?: Error;
  existing?: Readonly<{ state: CommandReceipt["state"]; result: JsonValue }>;
}>) {
  const decisions: AdminDecisionRecord[] = [];
  const approvals: unknown[] = [];
  const events: OutboxEvent[] = [];
  let receipt: CommandReceipt | null = null;
  let executions = 0;
  let authorityLoads = 0;
  let outcomeWrites = 0;
  let handlerTransaction: PlatformTransaction | null = null;
  let reference = 0;
  const registry = new AdminLocalCommandRegistry([{ definition: input.definition,
    async execute(currentTransaction) {
      executions += 1;
      handlerTransaction = currentTransaction;
      return input.result;
    },
  }]);
  const service = new AdminCommandService({
    registry,
    unitOfWork: { async execute(_fence, work) { return work(transaction); } },
    repository: {
      async lockOperatorAuthority() {
        authorityLoads += 1;
        return input.authority ?? authority;
      },
      async recordDecision(_transaction, decision) { decisions.push(decision); },
      async createApproval(_transaction, approval) { approvals.push(approval); },
    },
    receipts: {
      async begin(_transaction, identity) {
        if (input.beginError) throw input.beginError;
        receipt = makeReceipt(identity, input.existing?.state ?? "pending", input.existing?.result ?? null);
        return receipt;
      },
      async recordOutcome(_transaction, identity, outcome) {
        outcomeWrites += 1;
        receipt = makeReceipt(identity, outcome.state, outcome.result, outcome.resultDigest);
        return receipt;
      },
    },
    outbox: { async enqueue(_transaction, event) { events.push(event); } },
    clock: () => new Date("2026-07-28T13:00:00.000Z"),
    reference: () => `reference_${++reference}`,
  });
  return {
    service, decisions, approvals, events,
    get receipt() { return receipt; },
    get executions() { return executions; },
    get authorityLoads() { return authorityLoads; },
    get outcomeWrites() { return outcomeWrites; },
    get handlerTransaction() { return handlerTransaction; },
  };
}

function submission(operation: string) {
  return Object.freeze({
    context: context(operation), commandId, idempotencyKey: "admin-operation-0001", operation,
    targetSiteRef: "site_01", reason: "security incident 1842", breakGlassTicketRef: null,
    payload: { siteRef: "site_01" } satisfies JsonValue,
  });
}

function context(operation: string): VerifiedRequestSecurityContext {
  return Object.freeze({
    requestId: "request_01", correlationId: "correlation_01",
    environment: "production", region: "us-east-1", audience: "platform.admin",
    trustedCaller: { kind: "admin_workload", workloadIdentityId: "admin_web_01",
      environment: "production", region: "us-east-1", audience: "platform.admin",
      allowedOperations: [operation], bindingEpoch: "1",
      issuedAt: "2026-07-28T12:00:00.000Z", expiresAt: "2026-07-28T14:00:00.000Z" },
    actor: { kind: "operator", subjectId: "operator_01", subjectGeneration: "3",
      assuranceLevel: "phishing_resistant", stepUpAt: "2026-07-28T12:58:00.000Z" },
    delegatedGrant: null,
    target: { siteId: "site_01", workspaceId: null, projectId: null,
      purpose: operation, scopes: ["site:lifecycle"] },
    evidence: [], policyEpoch: "1", issuedAt: "2026-07-28T12:58:00.000Z",
    expiresAt: "2026-07-28T13:05:00.000Z",
  }) as unknown as VerifiedRequestSecurityContext;
}

function makeReceipt(
  identity: CommandIdentity,
  state: CommandReceipt["state"],
  result: JsonValue | null,
  resultDigest: string | null = result === null ? null : "a".repeat(64),
): CommandReceipt {
  return Object.freeze({ ...identity, state, result, resultDigest });
}
