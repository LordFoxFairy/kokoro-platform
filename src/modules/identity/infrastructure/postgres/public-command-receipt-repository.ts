import type {
  PublicCommandReceiptDelivery,
  PublicCommandReceiptReadPort,
  PublicCommandReceiptRecord,
  PublicCommandReceiptRecovery,
  PublicCommandReceiptSessionOwner,
} from "../../application/services/public-command-receipt-service.js";
import { resolvePlatformTransaction } from
  "../../../../shared/unit-of-work/platform-transaction.js";

export class PostgresPublicCommandReceiptRepository implements PublicCommandReceiptReadPort {
  async find(
    transaction: Parameters<PublicCommandReceiptReadPort["find"]>[0],
    input: Parameters<PublicCommandReceiptReadPort["find"]>[1],
  ): Promise<PublicCommandReceiptRecord | null> {
    const rows = await resolvePlatformTransaction(transaction).query<ReceiptRow>(
      `WITH delivery AS (
         SELECT claim.command_id,claim.state AS delivery_state,claim.site_ref,
                NULL::text AS site_release_ref,NULL::text AS site_project_binding_ref,
                NULL::text AS workload_identity_id,NULL::bigint AS binding_epoch,
                claim.subject_ref,subject.subject_generation,claim.session_ref,
                identity_session.session_epoch,identity_session.credential_epoch,
                claim.request_digest
         FROM platform.identity_session_delivery_claim claim
         JOIN platform.authorization_subject subject
           ON subject.site_ref=claim.site_ref AND subject.subject_ref=claim.subject_ref
         JOIN platform.authorization_identity_session identity_session
           ON identity_session.site_ref=claim.site_ref
             AND identity_session.subject_ref=claim.subject_ref
             AND identity_session.session_ref=claim.session_ref
         UNION ALL
         SELECT claim.command_id,claim.state,claim.site_ref,claim.site_release_ref,
                claim.site_project_binding_ref,claim.workload_identity_id,claim.binding_epoch,
                claim.subject_ref,claim.subject_generation,claim.session_ref,
                claim.session_epoch,claim.credential_epoch,claim.request_digest
         FROM platform.identity_totp_enrollment_delivery_claim claim
         UNION ALL
         SELECT claim.command_id,claim.state,claim.site_ref,proof.site_release_ref,
                proof.site_project_binding_ref,proof.workload_identity_id,proof.binding_epoch,
                claim.subject_ref,proof.subject_generation,claim.session_ref,
                proof.session_epoch,proof.credential_epoch,claim.request_digest
         FROM platform.identity_reauthentication_delivery_claim claim
         JOIN platform.identity_reauthentication_proof proof
           ON proof.proof_digest=claim.proof_digest
         UNION ALL
         SELECT claim.command_id,claim.state,claim.site_ref,claim.site_release_ref,
                claim.site_project_binding_ref,claim.workload_identity_id,claim.binding_epoch,
                claim.subject_ref,claim.subject_generation,claim.session_ref,
                claim.session_epoch,claim.credential_epoch,claim.request_digest
         FROM platform.identity_recovery_code_delivery_claim claim
       )
       SELECT receipt.command_id AS "commandId",receipt.environment,receipt.region,
              receipt.caller_identity AS "callerIdentity",receipt.operation,
              receipt.request_digest AS "requestDigest",receipt.state AS "receiptState",
              recovery.site_ref AS "recoverySiteRef",
              recovery.site_release_ref AS "recoverySiteReleaseRef",
              recovery.site_project_binding_ref AS "recoverySiteProjectBindingRef",
              recovery.workload_identity_id AS "recoveryWorkloadIdentityId",
              recovery.binding_epoch AS "recoveryBindingEpoch",
              recovery.purpose AS "recoveryPurpose",
              recovery.transaction_ref AS "recoveryTransactionRef",
              recovery.capability_digest AS "recoveryCapabilityDigest",
              recovery.state AS "recoveryState",recovery.expires_at AS "recoveryExpiresAt",
              delivery.delivery_state AS "deliveryState",delivery.site_ref AS "deliverySiteRef",
              delivery.site_release_ref AS "deliverySiteReleaseRef",
              delivery.site_project_binding_ref AS "deliverySiteProjectBindingRef",
              delivery.workload_identity_id AS "deliveryWorkloadIdentityId",
              delivery.binding_epoch AS "deliveryBindingEpoch",
              delivery.subject_ref AS "deliverySubjectRef",
              delivery.subject_generation AS "deliverySubjectGeneration",
              delivery.session_ref AS "deliverySessionRef",
              delivery.session_epoch AS "deliverySessionEpoch",
              delivery.credential_epoch AS "deliveryCredentialEpoch",
              delivery.request_digest AS "deliveryRequestDigest",
              subject.restriction_epoch AS "ownerRestrictionEpoch"
       FROM platform.command_receipt receipt
       LEFT JOIN platform.identity_receipt_recovery_capability recovery
         ON recovery.command_id=receipt.command_id
       LEFT JOIN delivery ON delivery.command_id=receipt.command_id
       LEFT JOIN platform.authorization_subject subject
         ON subject.site_ref=delivery.site_ref AND subject.subject_ref=delivery.subject_ref
       WHERE receipt.command_id=$1 AND receipt.environment=$2 AND receipt.region=$3
         AND receipt.caller_identity=$4`,
      [
        input.commandId,
        input.environment,
        input.region,
        input.workloadIdentityId,
      ],
    );
    if (rows.length !== 1) return null;
    return record(rows[0]!);
  }
}

type ReceiptRow = Record<string, unknown>;

const RECOVERY_FIELDS = Object.freeze([
  "recoverySiteRef",
  "recoverySiteReleaseRef",
  "recoverySiteProjectBindingRef",
  "recoveryWorkloadIdentityId",
  "recoveryBindingEpoch",
  "recoveryPurpose",
  "recoveryTransactionRef",
  "recoveryCapabilityDigest",
  "recoveryState",
  "recoveryExpiresAt",
] as const);
const RECOVERY_REQUIRED_FIELDS = RECOVERY_FIELDS.filter((name) =>
  name !== "recoveryTransactionRef");
const DELIVERY_FIELDS = Object.freeze([
  "deliveryState",
  "deliverySiteRef",
  "deliverySubjectRef",
  "deliverySubjectGeneration",
  "deliverySessionRef",
  "deliverySessionEpoch",
  "deliveryCredentialEpoch",
  "deliveryRequestDigest",
  "ownerRestrictionEpoch",
] as const);

function record(row: ReceiptRow): PublicCommandReceiptRecord {
  const recovery = optionalRecovery(row);
  const delivery = optionalDelivery(row);
  const sessionOwner = delivery === null ? null : Object.freeze({
    siteRef: delivery.siteRef,
    siteReleaseRef: delivery.siteReleaseRef,
    siteProjectBindingRef: delivery.siteProjectBindingRef,
    workloadIdentityId: delivery.workloadIdentityId,
    bindingEpoch: delivery.bindingEpoch,
    subjectRef: delivery.subjectRef,
    subjectGeneration: delivery.subjectGeneration,
    sessionRef: delivery.sessionRef,
    sessionEpoch: delivery.sessionEpoch,
    restrictionEpoch: epoch(row.ownerRestrictionEpoch),
    credentialEpoch: delivery.credentialEpoch,
  } satisfies PublicCommandReceiptSessionOwner);
  return Object.freeze({
    commandId: text(row.commandId),
    environment: text(row.environment),
    region: text(row.region),
    callerIdentity: text(row.callerIdentity),
    operation: text(row.operation),
    requestDigest: digest(row.requestDigest),
    receiptState: receiptState(row.receiptState),
    recovery,
    delivery,
    sessionOwner,
  });
}

function optionalRecovery(row: ReceiptRow): PublicCommandReceiptRecovery | null {
  if (absent(row, RECOVERY_FIELDS)) return null;
  complete(row, RECOVERY_REQUIRED_FIELDS);
  const state = text(row.recoveryState);
  if (state !== "active" && state !== "consumed" && state !== "expired") invalid();
  return Object.freeze({
    siteRef: text(row.recoverySiteRef),
    siteReleaseRef: text(row.recoverySiteReleaseRef),
    siteProjectBindingRef: text(row.recoverySiteProjectBindingRef),
    workloadIdentityId: text(row.recoveryWorkloadIdentityId),
    bindingEpoch: epoch(row.recoveryBindingEpoch),
    purpose: text(row.recoveryPurpose),
    transactionRef: nullableText(row.recoveryTransactionRef),
    capabilityDigest: digest(row.recoveryCapabilityDigest),
    state,
    expiresAt: instant(row.recoveryExpiresAt),
  });
}

function optionalDelivery(row: ReceiptRow): PublicCommandReceiptDelivery | null {
  if (absent(row, DELIVERY_FIELDS)) return null;
  complete(row, DELIVERY_FIELDS);
  const state = text(row.deliveryState);
  if (state !== "first_claim_consumed" && state !== "superseded") invalid();
  return Object.freeze({
    state,
    siteRef: text(row.deliverySiteRef),
    siteReleaseRef: nullableText(row.deliverySiteReleaseRef),
    siteProjectBindingRef: nullableText(row.deliverySiteProjectBindingRef),
    workloadIdentityId: nullableText(row.deliveryWorkloadIdentityId),
    bindingEpoch: nullableEpoch(row.deliveryBindingEpoch),
    subjectRef: text(row.deliverySubjectRef),
    subjectGeneration: epoch(row.deliverySubjectGeneration),
    sessionRef: text(row.deliverySessionRef),
    sessionEpoch: epoch(row.deliverySessionEpoch),
    credentialEpoch: epoch(row.deliveryCredentialEpoch),
    requestDigest: digest(row.deliveryRequestDigest),
  });
}

function absent(row: ReceiptRow, names: readonly string[]): boolean {
  return names.every((name) => row[name] === null || row[name] === undefined);
}

function complete(row: ReceiptRow, names: readonly string[]): void {
  if (names.some((name) => row[name] === null || row[name] === undefined)) invalid();
}

function receiptState(value: unknown): PublicCommandReceiptRecord["receiptState"] {
  const state = text(value);
  if (state !== "pending" && state !== "succeeded" &&
      state !== "failed" && state !== "outcome_unknown") invalid();
  return state;
}

function text(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 ||
      [...value].some((character) => (character.codePointAt(0) ?? 0) < 32)) invalid();
  return value;
}

function nullableText(value: unknown): string | null {
  return value === null || value === undefined ? null : text(value);
}

function epoch(value: unknown): string {
  const parsed = typeof value === "bigint" ? value.toString() : text(value);
  if (!/^[1-9][0-9]*$/u.test(parsed)) invalid();
  return parsed;
}

function nullableEpoch(value: unknown): string | null {
  return value === null || value === undefined ? null : epoch(value);
}

function digest(value: unknown): string {
  const parsed = text(value);
  if (!/^[a-f0-9]{64}$/u.test(parsed)) invalid();
  return parsed;
}

function instant(value: unknown): string {
  const date = value instanceof Date ? value : new Date(text(value));
  if (!Number.isFinite(date.getTime())) invalid();
  return date.toISOString();
}

function invalid(): never {
  throw new Error("PUBLIC_COMMAND_RECEIPT_ROW_INVALID");
}
