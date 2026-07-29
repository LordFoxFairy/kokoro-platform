import { create } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import type { HandlerContext } from "@connectrpc/connect";
import { describe, expect, it, vi } from "vitest";
import {
  CommandDigestAlgorithmV2,
  CommandIdentityV2Schema,
  CommandReceiptStateV2,
  OperatorAssuranceLevel,
} from "../../src/interfaces/connect/generated-admin-v2/kokoro/common/v2/command_envelope_pb.js";
import {
  ApprovalDecision,
  ApprovalDecisionState,
  ChangeOperatorAuthoritySchema,
  DecideApprovalEffectSchema,
  DecideApprovalRequestSchema,
  GetReceiptRequestSchema,
  OperatorAuthorityChangeAction,
  SubmitCommandEffectSchema,
  SubmitCommandRequestSchema,
  SubmitCommandState,
} from "../../src/interfaces/connect/generated-admin-v2/kokoro/platform/admin/v2/admin_command_pb.js";
import {
  AuthenticatedOperatorCommandContextSchema,
  AuthenticatedOperatorQueryContextSchema,
  GlobalScopeSchema,
  OperatorScopeSchema,
  SecurityEpochsSchema,
} from "../../src/interfaces/connect/generated-admin-v2/kokoro/platform/admin/v2/admin_shared_pb.js";
import {
  decideApprovalRequestDigest,
  submitCommandRequestDigest,
  type VerifiedAuthenticatedAdminAxes,
} from "../../src/interfaces/connect/generated-admin-v2/command-envelope-digest.js";
import { createAdminCommandConnectService } from
  "../../src/modules/admin-control/interfaces/connect/admin-command-service.js";
import type { VerifiedRequestSecurityContext } from
  "../../src/shared/security-context/index.js";

const transport = {} as HandlerContext;
const recordedAt = "2026-07-29T12:03:00.000Z";
const authenticatedAt = timestampFromDate(new Date("2026-07-29T12:00:00.000Z"));
const stepUpAt = timestampFromDate(new Date("2026-07-29T12:02:00.000Z"));
const axes: VerifiedAuthenticatedAdminAxes = {
  workloadIdentityRef: "workload:web-admin",
  audience: "platform-admin",
  actorRef: "operator:7",
  operatorGeneration: 12n,
  operatorSessionRef: "session:9",
  environment: "production",
  region: "us-east-1",
  managedDeviceRef: "device:3",
  assuranceLevel: OperatorAssuranceLevel.PHISHING_RESISTANT,
  factorClasses: ["oidc", "webauthn"],
  authenticatedAt,
  stepUpAt,
  operatorAttestationRef: "attestation:operator:7:12",
  operatorAttestationDigest: "a".repeat(64),
};

describe("Admin command v2 Connect provider", () => {
  it("submits only the exact worker-owned authority payload and returns its durable receipt", async () => {
    const submitted = vi.fn(async () => ({
      disposition: "pending_approval" as const,
      approvalRef: "approval:1",
      commandId: "018f1212-1212-7212-8212-121212121212",
    }));
    const harness = service({ submit: submitted });
    const effect = authorityEffect();
    const context = commandContext("018f1212-1212-7212-8212-121212121212", "submit-key-0001");
    const digest = submitCommandRequestDigest(context, effect, axes);
    context.command!.requestDigest = digest;

    await expect(harness.submitCommand(create(SubmitCommandRequestSchema, { context, effect }), transport)).resolves.toMatchObject({
      state: SubmitCommandState.PENDING_APPROVAL,
      approvalRef: "approval:1",
      receipt: { state: CommandReceiptStateV2.COMMITTED, identity: { requestDigest: digest } },
    });
    expect(submitted).toHaveBeenCalledWith(expect.objectContaining({
      operation: "admin.authority.change",
      requestDigest: digest,
      targetSiteRef: null,
      payload: {
        action: "replace",
        operatorRef: "operator:42",
        operatorGeneration: "4",
        expectedAuthorizationEpoch: "7",
        permissions: ["admin.approval.execute", "admin.authority.manage"],
        siteScopes: ["*"],
        environments: ["production"],
        regions: ["us-east-1"],
        expiresAt: "2027-07-29T12:00:00.000Z",
        breakGlassExpiresAt: null,
      },
    }));
  });

  it("rejects digest drift before creating authority or approval state", async () => {
    const submitted = vi.fn();
    const harness = service({ submit: submitted });
    const context = commandContext("018f1212-1212-7212-8212-121212121212", "submit-key-0001");
    context.command!.requestDigest = "b".repeat(64);
    await expect(harness.submitCommand(create(SubmitCommandRequestSchema, {
      context,
      effect: authorityEffect(),
    }), transport))
      .rejects.toThrow("ADMIN_COMMAND_DIGEST_INVALID");
    expect(submitted).not.toHaveBeenCalled();
  });

  it("queues an independent approval using the official decision digest", async () => {
    const decide = vi.fn(async () => ({
      disposition: "execution_queued" as const,
      commandId: "018f1313-1313-7313-8313-131313131313",
      approvalRef: "approval:1",
    }));
    const harness = service({ decide });
    const effect = create(DecideApprovalEffectSchema, {
      approvalRef: "approval:1",
      decision: ApprovalDecision.APPROVE,
      reason: "independent approval",
    });
    const context = commandContext("018f1313-1313-7313-8313-131313131313", "approval-key-0001");
    context.command!.requestDigest = decideApprovalRequestDigest(context, effect, axes);

    await expect(harness.decideApproval(create(DecideApprovalRequestSchema, { context, effect }), transport)).resolves.toMatchObject({
      state: ApprovalDecisionState.EXECUTION_QUEUED,
      receipt: { state: CommandReceiptStateV2.COMMITTED },
    });
    expect(decide).toHaveBeenCalledWith(expect.objectContaining({
      decision: "approve",
      requestDigest: context.command!.requestDigest,
    }));
  });

  it("recovers a receipt only through a separately verified query context", async () => {
    const resolveQuery = vi.fn(async () => internalContext("admin.receipt.read"));
    const harness = service({ resolveQuery });
    const context = create(AuthenticatedOperatorQueryContextSchema, {
      requestId: "request:receipt",
      operatorSessionRef: "session:9",
      actorRef: "operator:7",
      operatorGeneration: 12n,
      environment: "production",
      region: "us-east-1",
      managedDeviceRef: "device:3",
      assuranceLevel: OperatorAssuranceLevel.PHISHING_RESISTANT,
      factorClasses: ["oidc", "webauthn"],
      authenticatedAt,
      stepUpAt,
      operatorAttestationRef: axes.operatorAttestationRef,
      operatorAttestationDigest: axes.operatorAttestationDigest,
      securityEpochs: create(SecurityEpochsSchema, {
        operatorSecurityEpoch: 2n,
        sessionEpoch: 11n,
        restrictionEpoch: 3n,
        policyEpoch: 5n,
      }),
      scope: create(OperatorScopeSchema, {
        kind: { case: "global", value: create(GlobalScopeSchema, {
          grantId: "grant:global",
          environment: "production",
          region: "us-east-1",
        }) },
      }),
    });
    await expect(harness.getReceipt(create(GetReceiptRequestSchema, {
      context,
      commandId: "018f1212-1212-7212-8212-121212121212",
      digestAlgorithm: CommandDigestAlgorithmV2.SHA256_COMMAND_ENVELOPE,
      requestDigest: "d".repeat(64),
    }), transport)).resolves.toMatchObject({ receipt: { state: CommandReceiptStateV2.COMMITTED } });
    expect(resolveQuery).toHaveBeenCalledWith(context, transport, "admin.receipt.read");
  });
});

function service(overrides: Readonly<{
  submit?: (...args: never[]) => Promise<unknown>;
  decide?: (...args: never[]) => Promise<unknown>;
  resolveQuery?: (...args: never[]) => Promise<unknown>;
}>) {
  return createAdminCommandConnectService({
    commands: { submit: overrides.submit ?? vi.fn() } as never,
    approvals: { decide: overrides.decide ?? vi.fn() } as never,
    resolver: {
      resolveCommand: async (
        _claimed: never,
        _transport: never,
        operation: "admin.authority.change" | "admin.approval.execute",
      ) => ({
        context: internalContext(operation),
        axes,
      }),
      resolveQuery: overrides.resolveQuery ?? (async () => internalContext("admin.receipt.read")),
    } as never,
    receipts: {
      read: async (_context, input) => ({
        commandId: input.commandId,
        idempotencyKey: "recovered-key-0001",
        requestDigest: input.requestDigest,
        operation: input.operation,
        environment: "production",
        region: "us-east-1",
        callerIdentity: "workload:web-admin:operator:7:12",
        state: "succeeded",
        result: null,
        resultDigest: "e".repeat(64),
        recordedAt,
      }),
    },
  });
}

function authorityEffect() {
  return create(SubmitCommandEffectSchema, {
    reason: "rotate operator scope",
    change: create(ChangeOperatorAuthoritySchema, {
      action: OperatorAuthorityChangeAction.REPLACE,
      operatorRef: "operator:42",
      operatorGeneration: 4n,
      expectedAuthorizationEpoch: 7n,
      permissions: ["admin.approval.execute", "admin.authority.manage"],
      siteIds: ["*"],
      environments: ["production"],
      regions: ["us-east-1"],
      expiresAt: timestampFromDate(new Date("2027-07-29T12:00:00.000Z")),
    }),
  });
}

function commandContext(commandId: string, idempotencyKey: string) {
  return create(AuthenticatedOperatorCommandContextSchema, {
    command: create(CommandIdentityV2Schema, {
      commandId,
      idempotencyKey,
      digestAlgorithm: CommandDigestAlgorithmV2.SHA256_COMMAND_ENVELOPE,
      requestDigest: "0".repeat(64),
    }),
    operatorSessionRef: axes.operatorSessionRef,
    actorRef: axes.actorRef,
    operatorGeneration: axes.operatorGeneration,
    environment: axes.environment,
    region: axes.region,
    managedDeviceRef: axes.managedDeviceRef,
    assuranceLevel: axes.assuranceLevel,
    factorClasses: [...axes.factorClasses],
    authenticatedAt,
    stepUpAt,
    operatorAttestationRef: axes.operatorAttestationRef,
    operatorAttestationDigest: axes.operatorAttestationDigest,
    securityEpochs: create(SecurityEpochsSchema, {
      operatorSecurityEpoch: 2n,
      sessionEpoch: 11n,
      restrictionEpoch: 3n,
      policyEpoch: 5n,
    }),
    scope: create(OperatorScopeSchema, {
      kind: { case: "global", value: create(GlobalScopeSchema, {
        grantId: "grant:global",
        environment: "production",
        region: "us-east-1",
      }) },
    }),
  });
}

function internalContext(operation: string): VerifiedRequestSecurityContext {
  return {
    requestId: "request:1",
    correlationId: "correlation:1",
    trustedCaller: {
      kind: "admin_workload",
      workloadIdentityId: "workload:web-admin",
      environment: "production",
      region: "us-east-1",
      audience: "platform-admin",
      allowedOperations: [operation],
      bindingEpoch: "1",
      issuedAt: "2026-07-29T12:00:00.000Z",
      expiresAt: "2026-07-29T13:00:00.000Z",
    },
    actor: { kind: "operator", subjectId: "operator:7", subjectGeneration: "12" },
    delegatedGrant: null,
    target: { siteId: null, workspaceId: null, projectId: null, purpose: operation, scopes: ["admin:global"] },
    audience: "platform-admin",
    environment: "production",
    region: "us-east-1",
    evidence: [],
    policyEpoch: "5",
    issuedAt: "2026-07-29T12:00:00.000Z",
    expiresAt: "2026-07-29T12:05:00.000Z",
  } as unknown as VerifiedRequestSecurityContext;
}
