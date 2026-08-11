import { timingSafeEqual } from "node:crypto";
import type { GetPublicCommandReceiptResponse } from
  "../../../../generated/contracts/openapi/platform-public/types.gen.js";
import type {
  AuthenticatedUserSession,
  ProductWorkloadIdentity,
} from "../../../authorization/domain/session-access-grant.js";
import type { VerifiedRequestSecurityContext } from
  "../../../../shared/security-context/index.js";
import type { PlatformTransaction } from
  "../../../../shared/unit-of-work/index.js";
import { canonicalCommandId, type CommandReceiptState } from
  "../../../../shared/outbox-inbox/receipt.js";
import type { IdentityAuditDigesterPort } from
  "../contracts/identity-security-ports.js";
import type { IdentityUnitOfWorkPort } from "./identity-application-service.js";
import { digestIdentityReceiptRecoveryCapability } from
  "./identity-receipt-recovery-digest.js";

type RecoveryState = "active" | "consumed" | "expired";
type DeliveryState = "first_claim_consumed" | "superseded";
const CORE_PUBLIC_RECEIPT_ORIGINAL_OPERATIONS: ReadonlySet<string> = new Set([
  "completeEmailVerification",
  "createIdentitySession",
  "completeSessionMfa",
  "refreshIdentitySession",
  "beginTotpEnrollment",
  "confirmTotpEnrollment",
  "regenerateRecoveryCodes",
  "reauthenticateIdentitySession",
]);

export type PublicCommandReceiptRecovery = Readonly<{
  siteRef: string;
  siteReleaseRef: string;
  siteProjectBindingRef: string;
  workloadIdentityId: string;
  bindingEpoch: string;
  purpose: string;
  transactionRef: string | null;
  capabilityDigest: string;
  state: RecoveryState;
  expiresAt: string;
}>;

export type PublicCommandReceiptDelivery = Readonly<{
  state: DeliveryState;
  siteRef: string;
  siteReleaseRef: string | null;
  siteProjectBindingRef: string | null;
  workloadIdentityId: string | null;
  bindingEpoch: string | null;
  subjectRef: string;
  subjectGeneration: string;
  sessionRef: string;
  sessionEpoch: string;
  credentialEpoch: string;
  requestDigest: string;
}>;

export type PublicCommandReceiptSessionOwner = Readonly<{
  siteRef: string;
  siteReleaseRef: string | null;
  siteProjectBindingRef: string | null;
  workloadIdentityId: string | null;
  bindingEpoch: string | null;
  subjectRef: string;
  subjectGeneration: string;
  sessionRef: string;
  sessionEpoch: string;
  restrictionEpoch: string;
  credentialEpoch: string;
}>;

export type PublicCommandReceiptRecord = Readonly<{
  commandId: string;
  environment: string;
  region: string;
  callerIdentity: string;
  operation: string;
  requestDigest: string;
  receiptState: CommandReceiptState;
  recovery: PublicCommandReceiptRecovery | null;
  delivery: PublicCommandReceiptDelivery | null;
  sessionOwner: PublicCommandReceiptSessionOwner | null;
}>;

export interface PublicCommandReceiptReadPort {
  find(
    transaction: PlatformTransaction,
    input: Readonly<{
      commandId: string;
      environment: string;
      region: string;
      siteRef: string;
      siteReleaseRef: string;
      siteProjectBindingRef: string;
      workloadIdentityId: string;
      bindingEpoch: string;
    }>,
  ): Promise<PublicCommandReceiptRecord | null>;
}

export class PublicCommandReceiptService {
  constructor(private readonly dependencies: Readonly<{
    unitOfWork: IdentityUnitOfWorkPort;
    repository: PublicCommandReceiptReadPort;
    auditDigest: IdentityAuditDigesterPort;
    clock?: () => Date;
  }>) {}

  async execute(input: Readonly<{
    workload: ProductWorkloadIdentity;
    context: VerifiedRequestSecurityContext;
    session: AuthenticatedUserSession | null;
    receiptRecoveryCapability: string | null;
    commandId: string;
  }>): Promise<GetPublicCommandReceiptResponse> {
    const commandId = safeCommandId(input.commandId);
    if (input.session === null && input.receiptRecoveryCapability === null) notFound();
    if (input.receiptRecoveryCapability !== null &&
        !validRecoveryCapability(input.receiptRecoveryCapability)) notFound();
    const now = instant((this.dependencies.clock ?? (() => new Date()))());
    return this.dependencies.unitOfWork.execute(
      { context: input.context, operation: "getPublicCommandReceipt" },
      async (transaction) => {
        const record = await this.dependencies.repository.find(transaction, {
          commandId,
          environment: input.workload.environment,
          region: input.workload.region,
          siteRef: input.workload.siteRef,
          siteReleaseRef: input.workload.siteReleaseRef,
          siteProjectBindingRef: input.workload.siteProjectBindingRef,
          workloadIdentityId: input.workload.workloadIdentityId,
          bindingEpoch: input.workload.bindingEpoch,
        });
        if (record === null || !sameBaseAuthority(record, input.workload, commandId) ||
            !sameRecordAuthority(record, input.workload)) notFound();
        if (input.session !== null && !sameSessionOwner(record, input.workload, input.session)) {
          notFound();
        }
        if (input.receiptRecoveryCapability !== null && !sameCapabilityOwner(
          record,
          input.workload,
          input.receiptRecoveryCapability,
          now,
          this.dependencies.auditDigest,
        )) notFound();
        return response(record, input.workload, now, this.dependencies.auditDigest);
      },
    );
  }
}

function sameBaseAuthority(
  record: PublicCommandReceiptRecord,
  workload: ProductWorkloadIdentity,
  commandId: string,
): boolean {
  return record.commandId === commandId &&
    record.environment === workload.environment &&
    record.region === workload.region &&
    record.callerIdentity === workload.workloadIdentityId &&
    CORE_PUBLIC_RECEIPT_ORIGINAL_OPERATIONS.has(record.operation) &&
    /^[a-f0-9]{64}$/u.test(record.requestDigest);
}

function sameSessionOwner(
  record: PublicCommandReceiptRecord,
  workload: ProductWorkloadIdentity,
  session: AuthenticatedUserSession,
): boolean {
  const owner = record.sessionOwner;
  if (owner === null || record.delivery === null || session.siteRef !== workload.siteRef) return false;
  return owner.siteRef === workload.siteRef && owner.subjectRef === session.subjectRef &&
    owner.subjectGeneration === session.subjectGeneration &&
    owner.sessionRef === session.identitySessionRef &&
    owner.sessionEpoch === session.identitySessionEpoch &&
    owner.restrictionEpoch === session.restrictionEpoch &&
    owner.credentialEpoch === session.credentialEpoch;
}

function sameRecordAuthority(
  record: PublicCommandReceiptRecord,
  workload: ProductWorkloadIdentity,
): boolean {
  const recovery = record.recovery;
  if (recovery === null ||
    recovery.siteRef !== workload.siteRef ||
    recovery.siteReleaseRef !== workload.siteReleaseRef ||
    recovery.siteProjectBindingRef !== workload.siteProjectBindingRef ||
    recovery.workloadIdentityId !== workload.workloadIdentityId ||
    recovery.bindingEpoch !== workload.bindingEpoch
  ) return false;
  const owner = record.sessionOwner;
  if (owner !== null && (
    owner.siteRef !== workload.siteRef ||
    (owner.siteReleaseRef !== null && owner.siteReleaseRef !== workload.siteReleaseRef) ||
    (owner.siteProjectBindingRef !== null &&
      owner.siteProjectBindingRef !== workload.siteProjectBindingRef) ||
    (owner.workloadIdentityId !== null &&
      owner.workloadIdentityId !== workload.workloadIdentityId) ||
    (owner.bindingEpoch !== null && owner.bindingEpoch !== workload.bindingEpoch)
  )) return false;
  const delivery = record.delivery;
  return delivery === null || (
    delivery.siteRef === workload.siteRef && delivery.requestDigest === record.requestDigest &&
    (delivery.siteReleaseRef === null || delivery.siteReleaseRef === workload.siteReleaseRef) &&
    (delivery.siteProjectBindingRef === null ||
      delivery.siteProjectBindingRef === workload.siteProjectBindingRef) &&
    (delivery.workloadIdentityId === null ||
      delivery.workloadIdentityId === workload.workloadIdentityId) &&
    (delivery.bindingEpoch === null || delivery.bindingEpoch === workload.bindingEpoch) &&
    owner !== null && delivery.subjectRef === owner.subjectRef &&
    delivery.subjectGeneration === owner.subjectGeneration &&
    delivery.sessionRef === owner.sessionRef && delivery.sessionEpoch === owner.sessionEpoch &&
    delivery.credentialEpoch === owner.credentialEpoch
  );
}

function sameCapabilityOwner(
  record: PublicCommandReceiptRecord,
  workload: ProductWorkloadIdentity,
  capability: string,
  now: string,
  digest: IdentityAuditDigesterPort,
): boolean {
  const recovery = record.recovery;
  if (recovery === null || recovery.state !== "active" ||
      Date.parse(recovery.expiresAt) <= Date.parse(now)) return false;
  const candidate = digestIdentityReceiptRecoveryCapability(
    digest,
    recovery.purpose,
    capability,
    workload,
  );
  return sameDigest(candidate, recovery.capabilityDigest);
}

function response(
  record: PublicCommandReceiptRecord,
  workload: ProductWorkloadIdentity,
  observedAt: string,
  digest: IdentityAuditDigesterPort,
): GetPublicCommandReceiptResponse {
  const common = Object.freeze({
    commandId: record.commandId,
    deliveryState: "not_applicable" as const,
    observedAt,
    requestDigest: record.requestDigest,
  });
  if (record.receiptState === "pending") {
    return Object.freeze({
      receipt: Object.freeze({ ...common, state: "accepted" as const }),
      reconciliation: Object.freeze({ kind: "pending" as const, retryAfterSeconds: 2 }),
    });
  }
  if (record.receiptState === "outcome_unknown") {
    return Object.freeze({
      receipt: Object.freeze({ ...common, state: "outcome_unknown" as const }),
      reconciliation: Object.freeze({ kind: "pending" as const, retryAfterSeconds: 2 }),
    });
  }
  if (record.receiptState === "failed") {
    return Object.freeze({
      receipt: Object.freeze({ ...common, state: "rejected" as const }),
      reconciliation: Object.freeze({ kind: "terminal" as const, outcome: "rejected" as const }),
    });
  }
  if (record.delivery?.state === "superseded") {
    return Object.freeze({
      receipt: Object.freeze({
        ...common,
        deliveryState: "superseded" as const,
        state: "committed" as const,
      }),
      reconciliation: Object.freeze({ kind: "terminal" as const, outcome: "committed" as const }),
    });
  }
  if (record.delivery?.state === "first_claim_consumed") {
    const recovery = record.recovery;
    if (recovery === null || recovery.state !== "active" ||
        Date.parse(recovery.expiresAt) <= Date.parse(observedAt)) notFound();
    const operationId = supersedingOperation(record.operation, recovery.purpose);
    if (operationId === null) notFound();
    const transactionRef = recovery.transactionRef ?? record.commandId;
    const bindingDigest = digest({
      purpose: "public-command-receipt-superseding-ceremony",
      siteRef: workload.siteRef,
      siteReleaseRef: workload.siteReleaseRef,
      siteProjectBindingRef: workload.siteProjectBindingRef,
      workloadIdentityId: workload.workloadIdentityId,
      bindingEpoch: workload.bindingEpoch,
      operationId,
      priorCommandId: record.commandId,
      transactionRef,
      expiresAt: recovery.expiresAt,
    });
    if (!/^[a-f0-9]{64}$/u.test(bindingDigest)) {
      throw new Error("PUBLIC_COMMAND_RECEIPT_BINDING_DIGEST_INVALID");
    }
    return Object.freeze({
      receipt: Object.freeze({
        ...common,
        deliveryState: "first_claim_consumed" as const,
        state: "committed" as const,
      }),
      reconciliation: Object.freeze({
        kind: "superseding_ceremony_required" as const,
        ceremony: Object.freeze({
          bindingDigest,
          expiresAt: recovery.expiresAt,
          invalidatesPriorDelivery: true as const,
          operationId,
          transactionRef,
        }),
      }),
    });
  }
  return Object.freeze({
    receipt: Object.freeze({ ...common, state: "committed" as const }),
    reconciliation: Object.freeze({ kind: "terminal" as const, outcome: "committed" as const }),
  });
}

function supersedingOperation(
  originalOperation: string,
  recoveryPurpose: string,
): "createIdentitySession" | "completeSessionMfa" | "refreshIdentitySession" |
  "beginTotpEnrollment" | "regenerateRecoveryCodes" |
  "reauthenticateIdentitySession" | "completeAccountRecovery" | null {
  const expected = originalOperation === "confirmTotpEnrollment"
    ? "regenerateRecoveryCodes"
    : originalOperation;
  if (expected !== recoveryPurpose || ![
    "createIdentitySession",
    "completeSessionMfa",
    "refreshIdentitySession",
    "beginTotpEnrollment",
    "regenerateRecoveryCodes",
    "reauthenticateIdentitySession",
    "completeAccountRecovery",
  ].includes(expected)) return null;
  return expected as Exclude<ReturnType<typeof supersedingOperation>, null>;
}

function validRecoveryCapability(value: string): boolean {
  return value.length >= 32 && value.length <= 2048 && value.trim() === value && !/\s/u.test(value);
}

function sameDigest(left: string, right: string): boolean {
  if (!/^[a-f0-9]{64}$/u.test(left) || !/^[a-f0-9]{64}$/u.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, "ascii"), Buffer.from(right, "ascii"));
}

function safeCommandId(value: string): string {
  try { return canonicalCommandId(value); }
  catch { notFound(); }
}

function instant(value: Date): string {
  if (!Number.isFinite(value.getTime())) {
    throw new Error("PUBLIC_COMMAND_RECEIPT_CLOCK_INVALID");
  }
  return value.toISOString();
}

function notFound(): never {
  throw new Error("PUBLIC_COMMAND_RECEIPT_NOT_FOUND");
}
