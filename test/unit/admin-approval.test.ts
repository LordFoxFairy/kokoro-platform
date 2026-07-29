import { describe, expect, it } from "vitest";
import type { VerifiedRequestSecurityContext } from "../../src/shared/security-context/index.js";
import type { PlatformTransaction } from "../../src/shared/unit-of-work/index.js";
import type { CommandReceipt, JsonValue } from "../../src/shared/outbox-inbox/receipt.js";
import {
  AdminApprovalService,
} from "../../src/modules/admin-control/application/admin-approval-service.js";
import {
  AdminLocalCommandRegistry,
  type AdminHandlerResult,
} from "../../src/modules/admin-control/application/admin-command-service.js";
import { digestAdminValue } from "../../src/modules/admin-control/application/admin-digest.js";
import {
  admitAdminApproval,
  type AdminApprovalRecord,
} from "../../src/modules/admin-control/domain/admin-approval.js";
import {
  defineAdminCommand,
  type AdminCommandAdmission,
  type AdminOperatorAuthority,
} from "../../src/modules/admin-control/domain/admin-command.js";

const transaction = Object.freeze({}) as PlatformTransaction;
const executionCommandId = "018f1313-1313-7313-8313-131313131313";
const definition = defineAdminCommand({
  commandId: "site.suspend", permission: "site.lifecycle.suspend", effectClass: "dangerous",
  scopeKind: "site", approvalPolicy: "pre_effect", reasonRequired: true,
});
const maker: AdminOperatorAuthority = Object.freeze({
  operatorRef: "maker_01", operatorGeneration: 2n, state: "active",
  permissions: ["site.lifecycle.suspend"], siteScopes: ["site_01"],
  environments: ["production"], regions: ["us-east-1"], authorizationEpoch: 8n,
  expiresAt: "2026-07-28T14:00:00.000Z", breakGlassExpiresAt: null,
});
const checker: AdminOperatorAuthority = Object.freeze({
  operatorRef: "checker_01", operatorGeneration: 4n, state: "active",
  permissions: ["admin.approval.execute", "site.lifecycle.suspend"], siteScopes: ["site_01"],
  environments: ["production"], regions: ["us-east-1"], authorizationEpoch: 11n,
  expiresAt: "2026-07-28T14:00:00.000Z", breakGlassExpiresAt: null,
});
const originalAdmission: AdminCommandAdmission = Object.freeze({
  commandId: definition.commandId, operatorRef: maker.operatorRef,
  operatorGeneration: maker.operatorGeneration, authorizationEpoch: maker.authorizationEpoch,
  siteRef: "site_01", environment: "production", region: "us-east-1",
  effectClass: "dangerous", approvalPolicy: "pre_effect", reason: "incident 1842",
  breakGlassTicketRef: null, admittedAt: "2026-07-28T12:55:00.000Z",
});
const payload: JsonValue = Object.freeze({ siteRef: "site_01" });
const approval: AdminApprovalRecord = Object.freeze({
  approvalRef: "approval_01", commandId: "018f1212-1212-7212-8212-121212121212",
  requestDigest: "a".repeat(64), payload, payloadDigest: digestAdminValue(payload),
  admission: originalAdmission, state: "pending", revision: 1n,
  expiresAt: "2026-07-28T13:15:00.000Z",
});

describe("Admin maker/checker approval", () => {
  it("requires a distinct, current, scoped, phishing-resistant checker", () => {
    expect(admitAdminApproval({ approval, definition, context: checkerContext(),
      makerAuthority: maker, checkerAuthority: checker, decision: "approve",
      reason: "independent approval", now: "2026-07-28T13:00:00.000Z" })).toMatchObject({
      makerRef: "maker_01", checkerRef: "checker_01", makerAuthorizationEpoch: 8n,
      checkerAuthorizationEpoch: 11n, decision: "approve", siteRef: "site_01",
    });
  });

  it("rejects self-approval and a maker admission whose authority epoch changed", () => {
    expect(() => admitAdminApproval({ approval, definition,
      context: checkerContext({ actor: { ...checkerContext().actor, subjectId: "maker_01",
        subjectGeneration: "2" } }), makerAuthority: maker,
      checkerAuthority: { ...checker, operatorRef: "maker_01", operatorGeneration: 2n },
      decision: "approve", reason: "self approve", now: "2026-07-28T13:00:00.000Z" }))
      .toThrow("ADMIN_CHECKER_AUTHORITY_INVALID");
    expect(() => admitAdminApproval({ approval, definition, context: checkerContext(),
      makerAuthority: { ...maker, authorizationEpoch: 9n }, checkerAuthority: checker,
      decision: "approve", reason: "independent approval", now: "2026-07-28T13:00:00.000Z" }))
      .toThrow("ADMIN_MAKER_AUTHORITY_STALE");
  });

  it("executes the frozen owner command and approval transition in one Platform transaction", async () => {
    const harness = serviceHarness({ handlerResult: { disposition: "succeeded",
      result: { deploymentRef: "deployment_01" } } });

    const result = await harness.service.decide(decision("approve"));

    expect(result).toEqual({ disposition: "executed", commandId: executionCommandId,
      approvalRef: "approval_01", result: { deploymentRef: "deployment_01" } });
    expect(harness.executions).toBe(1);
    expect(harness.handlerTransaction).toBe(transaction);
    expect(harness.handlerInput).toMatchObject({ admission: originalAdmission,
      approval: { checkerRef: "checker_01", makerRef: "maker_01" },
      payload, requestDigest: approval.requestDigest });
    expect(harness.transitions).toMatchObject([{ approvalRef: "approval_01",
      expectedRevision: 1n, state: "executed" }]);
    expect(harness.events).toMatchObject([{ eventType: "admin.approval.executed" }]);
    expect(harness.receipt?.state).toBe("succeeded");
  });

  it("lets the checker reject without invoking the business owner handler", async () => {
    const harness = serviceHarness({ handlerResult: { disposition: "succeeded", result: null } });

    await expect(harness.service.decide(decision("reject"))).resolves.toMatchObject({
      disposition: "rejected", approvalRef: "approval_01",
    });
    expect(harness.executions).toBe(0);
    expect(harness.transitions).toMatchObject([{ state: "rejected" }]);
  });

  it("fails closed before authority or effect when the frozen payload was tampered", async () => {
    const harness = serviceHarness({
      approval: { ...approval, payload: { siteRef: "site_02" } },
      handlerResult: { disposition: "succeeded", result: null },
    });

    await expect(harness.service.decide(decision("approve"))).resolves.toEqual({
      disposition: "denied", commandId: executionCommandId, approvalRef: "approval_01",
      code: "ADMIN_APPROVAL_PAYLOAD_INVALID",
    });
    expect(harness.authorityLoads).toBe(0);
    expect(harness.executions).toBe(0);
    expect(harness.receipt?.state).toBe("failed");
  });
});

function serviceHarness(input: Readonly<{
  approval?: AdminApprovalRecord;
  handlerResult: AdminHandlerResult;
}>) {
  const selectedApproval = input.approval ?? approval;
  const transitions: unknown[] = [];
  const events: unknown[] = [];
  let executions = 0;
  let authorityLoads = 0;
  let handlerTransaction: PlatformTransaction | null = null;
  let handlerInput: unknown;
  let receipt: CommandReceipt | null = null;
  let reference = 0;
  const registry = new AdminLocalCommandRegistry([{ definition,
    async execute(currentTransaction, currentInput) {
      executions += 1;
      handlerTransaction = currentTransaction;
      handlerInput = currentInput;
      return input.handlerResult;
    },
  }]);
  const service = new AdminApprovalService({
    unitOfWork: { async execute(_fence, work) { return work(transaction); } },
    registry,
    repository: {
      async lockApproval() { return selectedApproval; },
      async lockOperatorAuthority(_transaction, identity) {
        authorityLoads += 1;
        return identity.operatorRef === maker.operatorRef ? maker : checker;
      },
      async transitionApproval(_transaction, transition) { transitions.push(transition); return true; },
      async recordApprovalDecision() {},
    },
    receipts: {
      async begin(_transaction, identity) {
        receipt = { ...identity, state: "pending", result: null, resultDigest: null };
        return receipt;
      },
      async recordOutcome(_transaction, identity, outcome) {
        receipt = { ...identity, ...outcome };
        return receipt;
      },
    },
    outbox: { async enqueue(_transaction, event) { events.push(event); } },
    clock: () => new Date("2026-07-28T13:00:00.000Z"),
    reference: () => `reference_${++reference}`,
  });
  return {
    service, transitions, events,
    get executions() { return executions; },
    get authorityLoads() { return authorityLoads; },
    get handlerTransaction() { return handlerTransaction; },
    get handlerInput() { return handlerInput; },
    get receipt() { return receipt; },
  };
}

function decision(value: "approve" | "reject") {
  return Object.freeze({ context: checkerContext(), commandId: executionCommandId,
    idempotencyKey: "approval-decision-0001", approvalRef: "approval_01",
    decision: value, reason: "independent approval" });
}

function checkerContext(patch: Record<string, unknown> = {}): VerifiedRequestSecurityContext {
  return Object.freeze({
    requestId: "request_02", correlationId: "correlation_02",
    environment: "production", region: "us-east-1", audience: "platform.admin",
    trustedCaller: { kind: "admin_workload", workloadIdentityId: "admin_web_01",
      environment: "production", region: "us-east-1", audience: "platform.admin",
      allowedOperations: ["admin.approval.execute"], bindingEpoch: "1",
      issuedAt: "2026-07-28T12:00:00.000Z", expiresAt: "2026-07-28T14:00:00.000Z" },
    actor: { kind: "operator", subjectId: "checker_01", subjectGeneration: "4",
      assuranceLevel: "phishing_resistant", stepUpAt: "2026-07-28T12:58:00.000Z" },
    delegatedGrant: null,
    target: { siteId: "site_01", workspaceId: null, projectId: null,
      purpose: "admin.approval.execute", scopes: ["admin:approval"] },
    evidence: [], policyEpoch: "1", issuedAt: "2026-07-28T12:58:00.000Z",
    expiresAt: "2026-07-28T13:05:00.000Z",
    ...patch,
  }) as unknown as VerifiedRequestSecurityContext;
}
