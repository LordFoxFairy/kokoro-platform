import { create } from "@bufbuild/protobuf";
import { timestampDate, timestampFromDate } from "@bufbuild/protobuf/wkt";
import type { HandlerContext, ServiceImpl } from "@connectrpc/connect";
import {
  CommandDigestAlgorithmV2,
  CommandIdentityV2Schema,
  CommandReceiptV2Schema,
  CommandReceiptStateV2,
} from "../../../../interfaces/connect/generated-admin-v2/kokoro/common/v2/command_envelope_pb.js";
import {
  AdminCommandService as AdminCommandServiceDescriptor,
  ApprovalDecision,
  ApprovalDecisionState,
  OperatorAuthorityChangeAction,
  SubmitCommandState,
  type ChangeOperatorAuthority,
} from "../../../../interfaces/connect/generated-admin-v2/kokoro/platform/admin/v2/admin_command_pb.js";
import type {
  AuthenticatedOperatorCommandContext,
  AuthenticatedOperatorQueryContext,
} from "../../../../interfaces/connect/generated-admin-v2/kokoro/platform/admin/v2/admin_shared_pb.js";
import {
  decideApprovalRequestDigest,
  submitCommandRequestDigest,
  type VerifiedAuthenticatedAdminAxes,
} from "../../../../interfaces/connect/generated-admin-v2/command-envelope-digest.js";
import type { JsonValue } from "../../../../shared/outbox-inbox/receipt.js";
import type { VerifiedRequestSecurityContext } from
  "../../../../shared/security-context/index.js";
import {
  AdminCommandService as AdminCommandApplicationService,
} from "../../application/admin-command-service.js";
import { AdminApprovalService } from "../../application/admin-approval-service.js";
import type {
  AdminCommandReceiptReaderPort,
  AdminCommandReceiptRecord,
} from "../../infrastructure/postgres/admin-command-receipt-reader.js";

export type AdminCommandConnectService = ServiceImpl<typeof AdminCommandServiceDescriptor>;

export interface VerifiedAdminOperatorContextResolver {
  resolveCommand(
    claimed: AuthenticatedOperatorCommandContext,
    transport: HandlerContext,
    operation: "admin.authority.change" | "admin.approval.execute",
  ): Promise<Readonly<{
    context: VerifiedRequestSecurityContext;
    axes: VerifiedAuthenticatedAdminAxes;
  }>>;
  resolveQuery(
    claimed: AuthenticatedOperatorQueryContext,
    transport: HandlerContext,
    operation: "admin.receipt.read",
  ): Promise<VerifiedRequestSecurityContext>;
}

export function createAdminCommandConnectService(input: Readonly<{
  commands: AdminCommandApplicationService;
  approvals: AdminApprovalService;
  receipts: AdminCommandReceiptReaderPort;
  resolver: VerifiedAdminOperatorContextResolver;
}>): AdminCommandConnectService {
  if (typeof input.resolver?.resolveCommand !== "function" ||
      typeof input.resolver.resolveQuery !== "function") {
    throw new Error("ADMIN_VERIFIED_OPERATOR_RESOLVER_REQUIRED");
  }
  return {
    async submitCommand(request, transport) {
      const claimed = required(request.context, "ADMIN_COMMAND_CONTEXT_REQUIRED");
      const effect = required(request.effect, "ADMIN_COMMAND_EFFECT_REQUIRED");
      const identity = commandIdentity(claimed);
      const verified = await input.resolver.resolveCommand(
        claimed,
        transport,
        "admin.authority.change",
      );
      const expectedDigest = submitCommandRequestDigest(claimed, effect, verified.axes);
      requireDigest(identity.requestDigest, expectedDigest);
      const result = await input.commands.submit({
        context: verified.context,
        commandId: identity.commandId,
        idempotencyKey: identity.idempotencyKey,
        requestDigest: identity.requestDigest,
        operation: "admin.authority.change",
        targetSiteRef: null,
        reason: effect.reason,
        breakGlassTicketRef: null,
        payload: authorityPayload(required(effect.change, "ADMIN_AUTHORITY_CHANGE_REQUIRED")),
      });
      const receipt = await input.receipts.read(verified.context, {
        commandId: identity.commandId,
        requestDigest: identity.requestDigest,
        operation: "admin.authority.change",
      });
      if (result.disposition !== "pending_approval") {
        throw new Error(result.disposition === "denied" || result.disposition === "rejected"
          ? result.code
          : "ADMIN_SUBMISSION_STATE_INVALID");
      }
      return {
        state: SubmitCommandState.PENDING_APPROVAL,
        approvalRef: result.approvalRef,
        receipt: wireReceipt(receipt),
      };
    },

    async decideApproval(request, transport) {
      const claimed = required(request.context, "ADMIN_COMMAND_CONTEXT_REQUIRED");
      const effect = required(request.effect, "ADMIN_APPROVAL_EFFECT_REQUIRED");
      const identity = commandIdentity(claimed);
      const verified = await input.resolver.resolveCommand(
        claimed,
        transport,
        "admin.approval.execute",
      );
      requireDigest(
        identity.requestDigest,
        decideApprovalRequestDigest(claimed, effect, verified.axes),
      );
      const result = await input.approvals.decide({
        context: verified.context,
        commandId: identity.commandId,
        idempotencyKey: identity.idempotencyKey,
        requestDigest: identity.requestDigest,
        approvalRef: effect.approvalRef,
        decision: approvalDecision(effect.decision),
        reason: effect.reason,
      });
      const receipt = await input.receipts.read(verified.context, {
        commandId: identity.commandId,
        requestDigest: identity.requestDigest,
        operation: "admin.approval.execute",
      });
      return {
        state: approvalState(result.disposition),
        receipt: wireReceipt(receipt),
      };
    },

    async getReceipt(request, transport) {
      if (request.digestAlgorithm !== CommandDigestAlgorithmV2.SHA256_COMMAND_ENVELOPE) {
        throw new Error("ADMIN_COMMAND_DIGEST_ALGORITHM_INVALID");
      }
      const claimed = required(request.context, "ADMIN_QUERY_CONTEXT_REQUIRED");
      const context = await input.resolver.resolveQuery(claimed, transport, "admin.receipt.read");
      const receipt = await input.receipts.read(context, {
        commandId: request.commandId,
        requestDigest: request.requestDigest,
        operation: "admin.receipt.read",
      });
      return { receipt: wireReceipt(receipt) };
    },
  };
}

function commandIdentity(context: AuthenticatedOperatorCommandContext) {
  const identity = required(context.command, "ADMIN_COMMAND_IDENTITY_REQUIRED");
  if (identity.digestAlgorithm !== CommandDigestAlgorithmV2.SHA256_COMMAND_ENVELOPE) {
    throw new Error("ADMIN_COMMAND_DIGEST_ALGORITHM_INVALID");
  }
  return identity;
}

function authorityPayload(change: ChangeOperatorAuthority): JsonValue {
  const action = authorityAction(change.action);
  const base = {
    action,
    operatorRef: change.operatorRef,
    operatorGeneration: change.operatorGeneration.toString(),
  };
  if (action === "suspend" || action === "revoke") {
    if (change.expectedAuthorizationEpoch === undefined ||
        change.permissions.length !== 0 || change.siteIds.length !== 0 ||
        change.environments.length !== 0 || change.regions.length !== 0 ||
        change.expiresAt !== undefined || change.breakGlassExpiresAt !== undefined) {
      throw new Error("ADMIN_AUTHORITY_CHANGE_INVALID");
    }
    return Object.freeze({
      ...base,
      expectedAuthorizationEpoch: change.expectedAuthorizationEpoch.toString(),
    });
  }
  if (change.permissions.length === 0 || change.siteIds.length === 0 ||
      change.environments.length === 0 || change.regions.length === 0 ||
      change.expiresAt === undefined ||
      (action === "replace" && change.expectedAuthorizationEpoch === undefined) ||
      (action === "provision" && change.expectedAuthorizationEpoch !== undefined)) {
    throw new Error("ADMIN_AUTHORITY_CHANGE_INVALID");
  }
  return Object.freeze({
    ...base,
    ...(change.expectedAuthorizationEpoch === undefined
      ? {}
      : { expectedAuthorizationEpoch: change.expectedAuthorizationEpoch.toString() }),
    permissions: [...change.permissions],
    siteScopes: [...change.siteIds],
    environments: [...change.environments],
    regions: [...change.regions],
    expiresAt: timestampDate(change.expiresAt).toISOString(),
    breakGlassExpiresAt: change.breakGlassExpiresAt === undefined
      ? null
      : timestampDate(change.breakGlassExpiresAt).toISOString(),
  });
}

function authorityAction(value: OperatorAuthorityChangeAction): "provision" | "replace" | "suspend" | "revoke" {
  if (value === OperatorAuthorityChangeAction.PROVISION) return "provision";
  if (value === OperatorAuthorityChangeAction.REPLACE) return "replace";
  if (value === OperatorAuthorityChangeAction.SUSPEND) return "suspend";
  if (value === OperatorAuthorityChangeAction.REVOKE) return "revoke";
  throw new Error("ADMIN_AUTHORITY_ACTION_INVALID");
}

function approvalDecision(value: ApprovalDecision): "approve" | "reject" {
  if (value === ApprovalDecision.APPROVE) return "approve";
  if (value === ApprovalDecision.REJECT) return "reject";
  throw new Error("ADMIN_APPROVAL_DECISION_INVALID");
}

function approvalState(value: "execution_queued" | "rejected" | "denied"): ApprovalDecisionState {
  if (value === "execution_queued") return ApprovalDecisionState.EXECUTION_QUEUED;
  if (value === "rejected") return ApprovalDecisionState.REJECTED;
  return ApprovalDecisionState.DENIED;
}

function wireReceipt(receipt: AdminCommandReceiptRecord) {
  return create(CommandReceiptV2Schema, {
    identity: create(CommandIdentityV2Schema, {
      commandId: receipt.commandId,
      idempotencyKey: receipt.idempotencyKey,
      digestAlgorithm: CommandDigestAlgorithmV2.SHA256_COMMAND_ENVELOPE,
      requestDigest: receipt.requestDigest,
    }),
    operation: receipt.operation,
    state: receiptState(receipt.state),
    recordedAt: timestampFromDate(new Date(receipt.recordedAt)),
  });
}

function receiptState(value: AdminCommandReceiptRecord["state"]): CommandReceiptStateV2 {
  if (value === "pending") return CommandReceiptStateV2.ACCEPTED;
  if (value === "succeeded") return CommandReceiptStateV2.COMMITTED;
  if (value === "failed") return CommandReceiptStateV2.REJECTED;
  return CommandReceiptStateV2.OUTCOME_UNKNOWN;
}

function requireDigest(actual: string, expected: string): void {
  if (actual !== expected) throw new Error("ADMIN_COMMAND_DIGEST_INVALID");
}

function required<Value>(value: Value | undefined, code: string): Value {
  if (value === undefined) throw new Error(code);
  return value;
}
