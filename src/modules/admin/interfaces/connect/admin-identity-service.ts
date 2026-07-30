import { create } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import type { HandlerContext, ServiceImpl } from "@connectrpc/connect";
import {
  CommandDigestAlgorithmV2,
  CommandIdentityV2Schema,
  CommandReceiptStateV2,
  CommandReceiptV2Schema,
} from "../../../../interfaces/connect/generated-admin-identity/kokoro/common/v2/command_envelope_pb.js";
import {
  AdminIdentityService as AdminIdentityServiceDescriptor,
  AdminSessionDeliverySchema,
} from "../../../../interfaces/connect/generated-admin-identity/kokoro/platform/identity/v1/admin_identity_pb.js";
import {
  beginOperatorLoginRequestDigest,
  beginStepUpRequestDigest,
  completeStepUpRequestDigest,
  exchangeOidcSessionRequestDigest,
  signOutRequestDigest,
  type VerifiedAdminWorkloadAxes,
  type VerifiedAuthenticatedAdminAxes,
} from "../../../../interfaces/connect/generated-admin-identity/command-envelope-digest.js";
import type { AdminOidcReceipt, AdminOidcService } from
  "../../application/services/admin-oidc-service.js";
import type { VerifiedRequestSecurityContext } from
  "../../../../shared/security-context/request-security-context.js";

export type AdminIdentityConnectService = ServiceImpl<typeof AdminIdentityServiceDescriptor>;

interface IdentityReceipt {
  readonly commandId: string;
  readonly idempotencyKey: string;
  readonly requestDigest: string;
  readonly operation: string;
  readonly recordedAt: string;
}

export interface AdminIdentityTransportResolver {
  resolveWorkload(
    claimed: Readonly<{
      workloadIdentityRef: string;
      environment: string;
      region: string;
      managedDeviceRef: string;
      audience: string;
    }>,
    transport: HandlerContext,
  ): Promise<VerifiedAdminWorkloadAxes>;
  resolveOperator(
    claimed: Parameters<typeof beginStepUpRequestDigest>[0],
    transport: HandlerContext,
    request: Readonly<{
      operation: "admin.identity.step-up.begin" | "admin.identity.step-up.complete" |
        "admin.identity.sign-out";
      requestedOperation?: string;
      resourceRefs?: readonly string[];
    }>,
  ): Promise<Readonly<{
    axes: VerifiedAuthenticatedAdminAxes;
    context: VerifiedRequestSecurityContext;
  }>>;
}

export interface AdminOperatorSessionService {
  beginStepUp(input: Readonly<{
    commandId: string;
    idempotencyKey: string;
    requestDigest: string;
    context: Parameters<typeof beginStepUpRequestDigest>[0];
    axes: VerifiedAuthenticatedAdminAxes;
    verifiedContext: VerifiedRequestSecurityContext;
    requestedOperation: string;
    resourceRefs: readonly string[];
    callbackRef: string;
  }>): Promise<Readonly<{
    transactionRef: string;
    authorizationUri: string;
    expiresAt: string;
    receipt: IdentityReceipt;
  }>>;
  completeStepUp(input: Readonly<{
    commandId: string;
    idempotencyKey: string;
    requestDigest: string;
    context: Parameters<typeof completeStepUpRequestDigest>[0];
    axes: VerifiedAuthenticatedAdminAxes;
    verifiedContext: VerifiedRequestSecurityContext;
    transactionRef: string;
    authorizationCode: string;
  }>): Promise<Readonly<{
    operatorSessionRef: string;
    stepUpAt: string;
    receipt: IdentityReceipt;
  }>>;
  signOut(input: Readonly<{
    commandId: string;
    idempotencyKey: string;
    requestDigest: string;
    context: Parameters<typeof signOutRequestDigest>[0];
    axes: VerifiedAuthenticatedAdminAxes;
    verifiedContext: VerifiedRequestSecurityContext;
    operatorSessionRef: string;
  }>): Promise<Readonly<{ receipt: IdentityReceipt }>>;
}

export function createAdminIdentityConnectService(input: Readonly<{
  oidc: AdminOidcService;
  sessions: AdminOperatorSessionService;
  resolver: AdminIdentityTransportResolver;
}>): AdminIdentityConnectService {
  return {
    async beginOperatorLogin(request, transport) {
      const context = required(request.context, "ADMIN_IDENTITY_CONTEXT_REQUIRED");
      const effect = required(request.effect, "ADMIN_IDENTITY_EFFECT_REQUIRED");
      const command = commandIdentity(context.command);
      const axes = await input.resolver.resolveWorkload(context, transport);
      const digest = beginOperatorLoginRequestDigest(context, effect, axes);
      requireDigest(command.requestDigest, digest);
      const result = await input.oidc.begin({
        commandId: command.commandId,
        idempotencyKey: command.idempotencyKey,
        requestDigest: digest,
        axes,
        returnIntentRef: effect.returnIntentRef,
        recoveryHandle: required(effect.recoveryProof, "ADMIN_RECOVERY_PROOF_REQUIRED").recoveryHandle,
      });
      return {
        transactionRef: result.transactionRef,
        authorizationUri: result.authorizationUri,
        expiresAt: timestamp(result.expiresAt),
        recoveryExpiresAt: timestamp(result.recoveryExpiresAt),
        receipt: wireReceipt(result.receipt),
      };
    },

    async exchangeOidcSession(request, transport) {
      const context = required(request.context, "ADMIN_IDENTITY_CONTEXT_REQUIRED");
      const effect = required(request.effect, "ADMIN_IDENTITY_EFFECT_REQUIRED");
      const command = commandIdentity(context.command);
      const axes = await input.resolver.resolveWorkload(context, transport);
      const digest = exchangeOidcSessionRequestDigest(context, effect, axes);
      requireDigest(command.requestDigest, digest);
      const result = await input.oidc.exchange({
        commandId: command.commandId,
        idempotencyKey: command.idempotencyKey,
        requestDigest: digest,
        axes,
        transactionRef: effect.transactionRef,
        authorizationCode: effect.authorizationCode,
        recoveryHandle: required(effect.recoveryProof, "ADMIN_RECOVERY_PROOF_REQUIRED").recoveryHandle,
      });
      return { delivery: wireDelivery(result), receipt: wireReceipt(result.receipt) };
    },

    async getOperatorSessionDelivery(request, transport) {
      const context = required(request.context, "ADMIN_IDENTITY_CONTEXT_REQUIRED");
      const proof = required(request.recoveryProof, "ADMIN_RECOVERY_PROOF_REQUIRED");
      const axes = await input.resolver.resolveWorkload(context, transport);
      const result = await input.oidc.getDelivery({
        requestId: context.requestId,
        axes,
        transactionRef: request.transactionRef,
        recoveryHandle: proof.recoveryHandle,
      });
      return {
        delivery: wireDelivery(result),
        originalExchangeReceipt: wireReceipt(result.receipt),
      };
    },

    async beginStepUp(request, transport) {
      const context = required(request.context, "ADMIN_IDENTITY_CONTEXT_REQUIRED");
      const effect = required(request.effect, "ADMIN_IDENTITY_EFFECT_REQUIRED");
      const command = commandIdentity(context.command);
      const verified = await input.resolver.resolveOperator(
        context,
        transport,
        { operation: "admin.identity.step-up.begin",
          requestedOperation: effect.requestedOperation, resourceRefs: effect.resourceRefs },
      );
      const digest = beginStepUpRequestDigest(context, effect, verified.axes);
      requireDigest(command.requestDigest, digest);
      const result = await input.sessions.beginStepUp({
        commandId: command.commandId,
        idempotencyKey: command.idempotencyKey,
        requestDigest: digest,
        context,
        axes: verified.axes,
        verifiedContext: verified.context,
        requestedOperation: effect.requestedOperation,
        resourceRefs: Object.freeze([...effect.resourceRefs]),
        callbackRef: effect.callbackRef,
      });
      return {
        transactionRef: result.transactionRef,
        authorizationUri: result.authorizationUri,
        expiresAt: timestamp(result.expiresAt),
        receipt: wireReceipt(result.receipt),
      };
    },

    async completeStepUp(request, transport) {
      const context = required(request.context, "ADMIN_IDENTITY_CONTEXT_REQUIRED");
      const effect = required(request.effect, "ADMIN_IDENTITY_EFFECT_REQUIRED");
      const command = commandIdentity(context.command);
      const verified = await input.resolver.resolveOperator(
        context,
        transport,
        { operation: "admin.identity.step-up.complete" },
      );
      const digest = completeStepUpRequestDigest(context, effect, verified.axes);
      requireDigest(command.requestDigest, digest);
      const result = await input.sessions.completeStepUp({
        commandId: command.commandId,
        idempotencyKey: command.idempotencyKey,
        requestDigest: digest,
        context,
        axes: verified.axes,
        verifiedContext: verified.context,
        transactionRef: effect.transactionRef,
        authorizationCode: effect.authorizationCode,
      });
      return {
        operatorSessionRef: result.operatorSessionRef,
        stepUpAt: timestamp(result.stepUpAt),
        receipt: wireReceipt(result.receipt),
      };
    },

    async signOut(request, transport) {
      const context = required(request.context, "ADMIN_IDENTITY_CONTEXT_REQUIRED");
      const effect = required(request.effect, "ADMIN_IDENTITY_EFFECT_REQUIRED");
      const command = commandIdentity(context.command);
      const verified = await input.resolver.resolveOperator(context, transport,
        { operation: "admin.identity.sign-out" });
      const digest = signOutRequestDigest(context, effect, verified.axes);
      requireDigest(command.requestDigest, digest);
      if (effect.operatorSessionRef !== context.operatorSessionRef) {
        throw new Error("ADMIN_SESSION_TARGET_MISMATCH");
      }
      const result = await input.sessions.signOut({
        commandId: command.commandId,
        idempotencyKey: command.idempotencyKey,
        requestDigest: digest,
        context,
        axes: verified.axes,
        verifiedContext: verified.context,
        operatorSessionRef: effect.operatorSessionRef,
      });
      return { receipt: wireReceipt(result.receipt) };
    },
  };
}

function commandIdentity(value: Parameters<typeof beginOperatorLoginRequestDigest>[0]["command"]) {
  const command = required(value, "ADMIN_COMMAND_IDENTITY_REQUIRED");
  if (command.digestAlgorithm !== CommandDigestAlgorithmV2.SHA256_COMMAND_ENVELOPE) {
    throw new Error("ADMIN_COMMAND_DIGEST_ALGORITHM_INVALID");
  }
  return command;
}

function wireDelivery(value: Readonly<{
  operatorSessionRef: string;
  deliveryEnvelope: string;
  sessionExpiresAt: string;
  deliveryExpiresAt: string;
}>) {
  return create(AdminSessionDeliverySchema, {
    operatorSessionRef: value.operatorSessionRef,
    sessionDeliveryEnvelope: value.deliveryEnvelope,
    expiresAt: timestamp(value.sessionExpiresAt),
    deliveryExpiresAt: timestamp(value.deliveryExpiresAt),
  });
}

function wireReceipt(value: IdentityReceipt | AdminOidcReceipt) {
  return create(CommandReceiptV2Schema, {
    identity: create(CommandIdentityV2Schema, {
      commandId: value.commandId,
      idempotencyKey: value.idempotencyKey,
      digestAlgorithm: CommandDigestAlgorithmV2.SHA256_COMMAND_ENVELOPE,
      requestDigest: value.requestDigest,
    }),
    operation: value.operation,
    state: CommandReceiptStateV2.COMMITTED,
    recordedAt: timestamp(value.recordedAt),
  });
}

function timestamp(value: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("ADMIN_IDENTITY_INSTANT_INVALID");
  return timestampFromDate(date);
}

function requireDigest(actual: string, expected: string): void {
  if (actual !== expected) throw new Error("ADMIN_COMMAND_DIGEST_INVALID");
}

function required<Value>(value: Value | undefined, code: string): Value {
  if (value === undefined) throw new Error(code);
  return value;
}
