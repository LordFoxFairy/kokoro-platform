import { createHash } from "node:crypto";
import { create, toBinary } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import type { HandlerContext, ServiceImpl } from "@connectrpc/connect";
import {
  CommandDigestAlgorithmV2,
  CommandIdentityV2Schema,
  CommandReceiptStateV2,
  CommandReceiptV2Schema,
} from "../../../../generated/proto/kokoro/common/v2/command_envelope_pb.js";
import type { AuthenticatedOperatorCommandContext } from
  "../../../../generated/proto/kokoro/platform/admin/v2/admin_shared_pb.js";
import {
  type ActivationFacts,
  ActivationFactsSchema,
  RequestActivationApprovalResponseSchema,
  SiteActivationState,
  SiteEffectApprovalState,
  SiteLifecycleService,
} from "../../../../generated/proto/kokoro/platform/site/v1/site_lifecycle_pb.js";
import {
  approveAndActivateRequestDigest,
  requestActivationApprovalRequestDigest,
  type VerifiedAuthenticatedAdminAxes,
} from "../../../../generated/contracts/platform-site-lifecycle@v1/digest.js";
import type { VerifiedRequestSecurityContext } from "../../../../shared/security-context/index.js";
import type { SiteDangerousAdminHandler } from "../../application/site-dangerous-admin-handler.js";

export type SiteLifecycleConnectService = ServiceImpl<typeof SiteLifecycleService>;

interface SiteLifecycleOwner {
  requestActivationApproval: SiteDangerousAdminHandler["requestActivationApproval"];
  approveAndActivate: SiteDangerousAdminHandler["approveAndActivate"];
}

export interface SiteLifecycleAdminResolver {
  resolveSiteCommand(
    claimed: AuthenticatedOperatorCommandContext,
    transport: HandlerContext,
    request: Readonly<{
      operation: "site.approval.request" | "site.activation.begin";
      siteRef: string;
      resourceRefs: readonly string[];
      allowedOperations: readonly (
        "site.approval.request" | "site.approval.approve" | "site.activation.begin"
      )[];
    }>,
  ): Promise<Readonly<{
    context: VerifiedRequestSecurityContext;
    axes: VerifiedAuthenticatedAdminAxes;
  }>>;
}

export function createSiteLifecycleConnectService(input: Readonly<{
  owner: SiteLifecycleOwner;
  resolver: SiteLifecycleAdminResolver;
}>): SiteLifecycleConnectService {
  return {
    async requestActivationApproval(request, transport) {
      const claimed = required(request.context, "SITE_LIFECYCLE_CONTEXT_REQUIRED");
      const effect = required(request.effect, "SITE_ACTIVATION_EFFECT_REQUIRED");
      const activation = required(effect.activation, "SITE_ACTIVATION_FACTS_REQUIRED");
      const facts = ownerFacts(activation);
      const verified = await input.resolver.resolveSiteCommand(claimed, transport, {
        operation: "site.approval.request", siteRef: request.siteId,
        resourceRefs: [effect.approvalRef, ...facts.resourceRefs],
        allowedOperations: ["site.approval.request"],
      });
      const identity = commandIdentity(claimed);
      requireDigest(identity.requestDigest,
        requestActivationApprovalRequestDigest(claimed, request.siteId, effect, verified.axes));
      const receipt = await input.owner.requestActivationApproval({
        commandId: identity.commandId, idempotencyKey: identity.idempotencyKey,
        requestDigest: identity.requestDigest,
        approvalRef: effect.approvalRef, siteRef: request.siteId,
        candidateReleaseRef: facts.targetReleaseRef,
        expectedActiveReleaseRef: facts.expectedActiveReleaseRef,
        activationFactsDigest: facts.digest,
        audience: activation.audience, sessionContractRevision: activation.sessionContractRevision,
        reason: activation.reason,
      }, verified.context);
      if (receipt.expiresAt === undefined || receipt.recordedAt === undefined) {
        throw new Error("SITE_APPROVAL_RECEIPT_INCOMPLETE");
      }
      return create(RequestActivationApprovalResponseSchema, {
        approvalRef: receipt.approvalRef, state: approvalState(receipt.state),
        expiresAt: timestampFromDate(new Date(receipt.expiresAt)),
        receipt: wireReceipt(identity, "site.approval.request", CommandReceiptStateV2.ACCEPTED,
          receipt.recordedAt),
      });
    },

    async approveAndActivate(request, transport) {
      const claimed = required(request.context, "SITE_LIFECYCLE_CONTEXT_REQUIRED");
      const effect = required(request.effect, "SITE_ACTIVATION_EFFECT_REQUIRED");
      const activation = required(effect.activation, "SITE_ACTIVATION_FACTS_REQUIRED");
      const facts = ownerFacts(activation);
      const identity = commandIdentity(claimed);
      const verified = await input.resolver.resolveSiteCommand(claimed, transport, {
        operation: "site.activation.begin", siteRef: request.siteId,
        resourceRefs: [effect.approvalRef, effect.activationAttemptRef, ...facts.resourceRefs],
        allowedOperations: ["site.approval.approve", "site.activation.begin"],
      });
      requireDigest(identity.requestDigest,
        approveAndActivateRequestDigest(claimed, request.siteId, effect, verified.axes));
      const receipt = await input.owner.approveAndActivate({
        commandId: identity.commandId, idempotencyKey: identity.idempotencyKey,
        approvalRef: effect.approvalRef, attemptRef: effect.activationAttemptRef,
        siteRef: request.siteId, candidateReleaseRef: facts.targetReleaseRef,
        expectedActiveReleaseRef: facts.expectedActiveReleaseRef,
        activationFactsDigest: facts.digest,
        audience: activation.audience, sessionContractRevision: activation.sessionContractRevision,
        reason: activation.reason,
      }, verified.context);
      if (receipt.attemptRef === undefined || receipt.recordedAt === undefined) {
        throw new Error("SITE_ACTIVATION_RECEIPT_INCOMPLETE");
      }
      return { activationAttemptRef: receipt.attemptRef, state: activationState(receipt.state),
        replayed: receipt.replayed,
        receipt: wireReceipt(identity, "site.activation.begin", CommandReceiptStateV2.COMMITTED,
          receipt.recordedAt) };
    },
  };
}

function commandIdentity(context: AuthenticatedOperatorCommandContext) {
  const identity = required(context.command, "SITE_LIFECYCLE_COMMAND_IDENTITY_REQUIRED");
  if (identity.digestAlgorithm !== CommandDigestAlgorithmV2.SHA256_COMMAND_ENVELOPE) {
    throw new Error("SITE_LIFECYCLE_COMMAND_DIGEST_ALGORITHM_INVALID");
  }
  return identity;
}

function requireDigest(actual: string, expected: string): void {
  if (actual !== expected) throw new Error("SITE_LIFECYCLE_COMMAND_DIGEST_INVALID");
}

function wireReceipt(
  identity: ReturnType<typeof commandIdentity>,
  operation: "site.approval.request" | "site.activation.begin",
  state: CommandReceiptStateV2,
  recordedAt: string,
) {
  const timestamp = new Date(recordedAt);
  if (!Number.isFinite(timestamp.getTime())) throw new Error("SITE_COMMAND_RECORDED_AT_INVALID");
  return create(CommandReceiptV2Schema, {
    identity: create(CommandIdentityV2Schema, {
      commandId: identity.commandId,
      idempotencyKey: identity.idempotencyKey,
      digestAlgorithm: identity.digestAlgorithm,
      requestDigest: identity.requestDigest,
    }),
    operation,
    state,
    recordedAt: timestampFromDate(timestamp),
  });
}

function required<Value>(value: Value | undefined, code: string): Value {
  if (value === undefined) throw new Error(code);
  return value;
}

function ownerFacts(activation: ActivationFacts) {
  const candidate = required(activation.candidate, "SITE_ACTIVATION_CANDIDATE_REQUIRED");
  const target = required(activation.targetRelease, "SITE_ACTIVATION_TARGET_RELEASE_REQUIRED");
  const pointer = required(activation.activePointer, "SITE_ACTIVATION_POINTER_REQUIRED");
  const fence = required(pointer.fence, "SITE_ACTIVATION_CAS_FENCE_REQUIRED");
  let pointerRef: string;
  let expectedActiveReleaseRef: string | null;
  if (pointer.current.case === "firstActivation") {
    if (pointer.expectedGeneration !== 0n) {
      throw new Error("SITE_ACTIVATION_FIRST_POINTER_GENERATION_INVALID");
    }
    pointerRef = pointer.current.value.pointerRef;
    expectedActiveReleaseRef = null;
  } else if (pointer.current.case === "existing") {
    const currentRelease = required(pointer.current.value.currentRelease,
      "SITE_ACTIVATION_CURRENT_RELEASE_REQUIRED");
    if (pointer.current.value.currentGeneration < 1n ||
        pointer.expectedGeneration !== pointer.current.value.currentGeneration) {
      throw new Error("SITE_ACTIVATION_EXISTING_POINTER_GENERATION_INVALID");
    }
    pointerRef = pointer.current.value.pointerRef;
    expectedActiveReleaseRef = currentRelease.ref;
  } else {
    throw new Error("SITE_ACTIVATION_POINTER_CURRENT_REQUIRED");
  }
  const digest = `sha256:${createHash("sha256")
    .update(toBinary(ActivationFactsSchema, activation, { writeUnknownFields: false }))
    .digest("hex")}`;
  return Object.freeze({
    targetReleaseRef: target.ref,
    expectedActiveReleaseRef,
    digest,
    resourceRefs: Object.freeze([
      candidate.candidateRef,
      target.ref,
      pointerRef,
      fence.casCommandRef,
    ]),
  });
}

function approvalState(value: "pending" | "approved" | "consumed"): SiteEffectApprovalState {
  if (value === "pending") return SiteEffectApprovalState.PENDING;
  if (value === "approved") return SiteEffectApprovalState.APPROVED;
  return SiteEffectApprovalState.CONSUMED;
}

function activationState(value: string): SiteActivationState {
  if (value === "preparing") return SiteActivationState.PREPARING;
  if (value === "promote_requested") return SiteActivationState.PROMOTE_REQUESTED;
  if (value === "observing") return SiteActivationState.OBSERVING;
  if (value === "pointer_committing") return SiteActivationState.POINTER_COMMITTING;
  if (value === "draining") return SiteActivationState.DRAINING;
  if (value === "succeeded") return SiteActivationState.SUCCEEDED;
  if (value === "failed") return SiteActivationState.FAILED;
  if (value === "unknown") return SiteActivationState.OUTCOME_UNKNOWN;
  throw new Error("SITE_ACTIVATION_STATE_INVALID");
}
