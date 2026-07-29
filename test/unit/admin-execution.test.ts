import { describe, expect, it } from "vitest";
import type { PlatformTransaction } from "../../src/shared/unit-of-work/index.js";
import type { ClaimedOutboxEvent } from "../../src/shared/outbox-inbox/outbox.js";
import { digestAdminValue } from "../../src/modules/admin-control/application/admin-digest.js";
import {
  AdminExecutionService,
} from "../../src/modules/admin-control/application/admin-execution-service.js";
import {
  AdminLocalCommandRegistry,
} from "../../src/modules/admin-control/application/admin-command-service.js";
import type {
  AdminApprovalAdmission,
  AdminApprovalRecord,
} from "../../src/modules/admin-control/domain/admin-approval.js";
import {
  defineAdminCommand,
  type AdminCommandAdmission,
  type AdminOperatorAuthority,
} from "../../src/modules/admin-control/domain/admin-command.js";

const transaction = Object.freeze({}) as PlatformTransaction;
const ownerOperation = "site.suspend";
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
const makerAdmission: AdminCommandAdmission = Object.freeze({
  commandId: ownerOperation, operatorRef: maker.operatorRef,
  operatorGeneration: maker.operatorGeneration, authorizationEpoch: maker.authorizationEpoch,
  siteRef: "site_01", environment: "production", region: "us-east-1",
  effectClass: "dangerous", approvalPolicy: "pre_effect", reason: "incident 1842",
  breakGlassTicketRef: null, admittedAt: "2026-07-28T12:55:00.000Z",
});
const checkerAdmission: AdminApprovalAdmission = Object.freeze({
  approvalRef: "018f1414-1414-7414-8414-141414141414",
  commandId: "018f1212-1212-7212-8212-121212121212", ownerOperation,
  checkerRef: checker.operatorRef, checkerGeneration: checker.operatorGeneration,
  checkerAuthorizationEpoch: checker.authorizationEpoch,
  makerRef: maker.operatorRef, makerGeneration: maker.operatorGeneration,
  makerAuthorizationEpoch: maker.authorizationEpoch,
  siteRef: "site_01", environment: "production", region: "us-east-1",
  decision: "approve", reason: "independent approval", admittedAt: "2026-07-28T13:00:00.000Z",
});
const payload = Object.freeze({ siteRef: "site_01" });
const approval: AdminApprovalRecord = Object.freeze({
  approvalRef: checkerAdmission.approvalRef, commandId: checkerAdmission.commandId,
  requestDigest: "a".repeat(64), payload, payloadDigest: digestAdminValue(payload),
  admission: makerAdmission, checker: checkerAdmission, state: "execution_queued", revision: 2n,
  expiresAt: "2026-07-28T13:15:00.000Z",
});

describe("Admin owner-axis execution", () => {
  it("executes a queued effect and terminal transition in the supplied owner transaction", async () => {
    const executions: unknown[] = [];
    const transitions: unknown[] = [];
    const completed: unknown[] = [];
    const registry = new AdminLocalCommandRegistry([{
      definition: defineAdminCommand({ commandId: ownerOperation,
        permission: "site.lifecycle.suspend", effectClass: "dangerous", scopeKind: "site",
        approvalPolicy: "pre_effect", reasonRequired: true }),
      async execute(current, input) {
        executions.push({ current, input });
        return { disposition: "succeeded" as const, result: { suspended: true } };
      },
    }]);
    const service = new AdminExecutionService({
      registry,
      repository: {
        async lockApproval() { return approval; },
        async lockOperatorAuthority(_current, identity) {
          return identity.operatorRef === maker.operatorRef ? maker : checker;
        },
        async completeExecution(_current, input) { transitions.push(input); return true; },
      },
      outbox: { async complete(_current, eventId, leaseToken) { completed.push({ eventId, leaseToken }); } },
      clock: () => new Date("2026-07-28T13:01:00.000Z"),
    });

    await service.executeClaim(transaction, executionEvent());

    expect(executions).toMatchObject([{ current: transaction,
      input: { admission: makerAdmission, approval: checkerAdmission, payload } }]);
    expect(transitions).toMatchObject([{ approvalRef: approval.approvalRef,
      expectedRevision: 2n, state: "executed", result: { suspended: true } }]);
    expect(completed).toEqual([{ eventId: "018f1515-1515-7515-8515-151515151515",
      leaseToken: "lease_0001" }]);
  });

  it("terminalizes stale frozen authority without invoking the owner handler", async () => {
    let executions = 0;
    const transitions: unknown[] = [];
    const service = new AdminExecutionService({
      registry: new AdminLocalCommandRegistry([{
        definition: defineAdminCommand({ commandId: ownerOperation,
          permission: "site.lifecycle.suspend", effectClass: "dangerous", scopeKind: "site",
          approvalPolicy: "pre_effect", reasonRequired: true }),
        async execute() { executions += 1; return { disposition: "succeeded" as const, result: null }; },
      }]),
      repository: {
        async lockApproval() { return approval; },
        async lockOperatorAuthority(_current, identity) {
          return identity.operatorRef === maker.operatorRef
            ? { ...maker, authorizationEpoch: maker.authorizationEpoch + 1n }
            : checker;
        },
        async completeExecution(_current, input) { transitions.push(input); return true; },
      },
      outbox: { async complete() {} },
      clock: () => new Date("2026-07-28T13:01:00.000Z"),
    });

    await service.executeClaim(transaction, executionEvent());

    expect(executions).toBe(0);
    expect(transitions).toMatchObject([{ state: "stale_authority",
      code: "ADMIN_EXECUTION_AUTHORITY_STALE" }]);
  });
});

function executionEvent(): ClaimedOutboxEvent {
  const eventPayload = Object.freeze({
    approvalRef: approval.approvalRef,
    originatingCommandId: approval.commandId,
    executionCommandId: "018f1313-1313-7313-8313-131313131313",
    ownerOperation,
    checkerRef: checker.operatorRef,
    checkerGeneration: checker.operatorGeneration.toString(),
    checkerAuthorizationEpoch: checker.authorizationEpoch.toString(),
    makerRef: maker.operatorRef,
    makerGeneration: maker.operatorGeneration.toString(),
    makerAuthorizationEpoch: maker.authorizationEpoch.toString(),
    siteRef: "site_01", environment: "production", region: "us-east-1",
    decision: "approve", outcome: { disposition: "execution_queued" },
  });
  return Object.freeze({
    eventId: "018f1515-1515-7515-8515-151515151515", owner: "admin-execution",
    eventType: "admin.approval.execution.requested", aggregateId: approval.approvalRef,
    payload: eventPayload, payloadDigest: digestAdminValue(eventPayload),
    correlationId: "correlation_01", causationId: "request_01",
    leaseToken: "lease_0001", attempt: 1,
  });
}
