import { createHash, createHmac } from "node:crypto";
import type {
  AdmissionMediaAccessOwnerPort,
  AdmissionOwnerResolution,
} from "../../application/platform-admission-owner-authority.js";
import { resolvePlatformTransaction } from "../../../../shared/unit-of-work/platform-transaction.js";

interface MediaAccessRow extends Record<string, unknown> {
  readonly handleDigest: string;
  readonly siteId: string;
  readonly projectRef: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly commandId: string;
  readonly requestDigest: string;
  readonly configurationRevisionId: string;
  readonly subjectRef: string;
  readonly subjectGeneration: bigint | string;
  readonly projectionReservationDigest: string;
  readonly reservationReceiptRef: string;
  readonly inputPolicyDecisionRef: string;
  readonly expiresAt: Date | string;
}

/** Issues an opaque, deterministic replayable capability while persisting keyed digests only. */
export class PostgresAdmissionMediaAccessOwner implements AdmissionMediaAccessOwnerPort {
  readonly #key: Buffer;

  constructor(key: Uint8Array) {
    if (key.byteLength !== 32) throw new Error("ADMISSION_MEDIA_ACCESS_KEY_INVALID");
    this.#key = Buffer.from(key);
  }

  async reserve(
    transaction: Parameters<AdmissionMediaAccessOwnerPort["reserve"]>[0],
    input: Parameters<AdmissionMediaAccessOwnerPort["reserve"]>[1],
  ): Promise<AdmissionOwnerResolution<Readonly<{ mediaAccessHandle: string }>>> {
    assertInput(input);
    const handleToken = hmac(this.#key, "kokoro.platform.media-access-handle.v1\0", [
      input.siteId, input.projectRef, input.sessionId, input.runId, input.commandId, input.requestDigest,
      input.configurationRevisionId, input.subjectRef, input.subjectGeneration.toString(),
      input.mediaProjectionReservationHandle, input.reservationReceiptRef,
      input.inputPolicyDecisionRef, input.maximumExpiresAt,
    ]).toString("base64url");
    const mediaAccessHandle = `media_access_v1.${handleToken}`;
    const handleDigest = createHash("sha256").update(mediaAccessHandle).digest("hex");
    const projectionReservationDigest = hmac(this.#key,
      "kokoro.platform.media-projection-reservation-handle.v1\0",
      [input.mediaProjectionReservationHandle]).toString("hex");
    const sql = resolvePlatformTransaction(transaction);
    await sql.execute(
      `INSERT INTO platform.admission_media_access_authorization
       (handle_digest,site_id,project_ref,session_id,run_id,command_id,request_digest,
        configuration_revision_id,subject_ref,subject_generation,projection_reservation_digest,
        reservation_receipt_ref,input_policy_decision_ref,expires_at,state)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::timestamptz,'reserved')
       ON CONFLICT (site_id,command_id) DO NOTHING`,
      [handleDigest, input.siteId, input.projectRef, input.sessionId, input.runId, input.commandId,
        input.requestDigest, input.configurationRevisionId, input.subjectRef,
        input.subjectGeneration.toString(), projectionReservationDigest, input.reservationReceiptRef,
        input.inputPolicyDecisionRef, input.maximumExpiresAt],
    );
    const rows = await sql.query<MediaAccessRow>(
      `SELECT handle_digest AS "handleDigest",site_id AS "siteId",project_ref AS "projectRef",
              session_id AS "sessionId",run_id AS "runId",command_id AS "commandId",
              request_digest AS "requestDigest",configuration_revision_id AS "configurationRevisionId",
              subject_ref AS "subjectRef",subject_generation AS "subjectGeneration",
              projection_reservation_digest AS "projectionReservationDigest",
              reservation_receipt_ref AS "reservationReceiptRef",
              input_policy_decision_ref AS "inputPolicyDecisionRef",expires_at AS "expiresAt"
         FROM platform.admission_media_access_authorization
        WHERE site_id=$1 AND command_id=$2 FOR UPDATE`,
      [input.siteId, input.commandId],
    );
    if (rows.length !== 1 || !matches(rows[0]!, input, handleDigest, projectionReservationDigest)) {
      throw new Error("ADMISSION_MEDIA_ACCESS_COMMAND_CONFLICT");
    }
    return Object.freeze({ kind: "resolved" as const,
      value: Object.freeze({ mediaAccessHandle }) });
  }
}

function matches(
  row: MediaAccessRow,
  input: Parameters<AdmissionMediaAccessOwnerPort["reserve"]>[1],
  handleDigest: string,
  projectionReservationDigest: string,
): boolean {
  return row.handleDigest === handleDigest && row.siteId === input.siteId &&
    row.projectRef === input.projectRef && row.sessionId === input.sessionId && row.runId === input.runId &&
    row.commandId === input.commandId && row.requestDigest === input.requestDigest &&
    row.configurationRevisionId === input.configurationRevisionId && row.subjectRef === input.subjectRef &&
    BigInt(row.subjectGeneration) === input.subjectGeneration &&
    row.projectionReservationDigest === projectionReservationDigest &&
    row.reservationReceiptRef === input.reservationReceiptRef &&
    row.inputPolicyDecisionRef === input.inputPolicyDecisionRef &&
    instant(row.expiresAt) === input.maximumExpiresAt;
}

function assertInput(input: Parameters<AdmissionMediaAccessOwnerPort["reserve"]>[1]): void {
  for (const value of [input.siteId, input.projectRef, input.sessionId, input.runId, input.commandId,
    input.configurationRevisionId, input.subjectRef, input.reservationReceiptRef,
    input.inputPolicyDecisionRef]) reference(value, 256);
  if (!/^[0-9a-f]{64}$/u.test(input.requestDigest) || input.subjectGeneration < 1n ||
      !reference(input.mediaProjectionReservationHandle, 8192) ||
      !canonicalInstant(input.maximumExpiresAt)) throw new Error("ADMISSION_MEDIA_ACCESS_INPUT_INVALID");
}

function hmac(key: Buffer, domain: string, values: readonly string[]): Buffer {
  const digest = createHmac("sha256", key).update(domain);
  for (const value of values) digest.update(lengthFrame(value));
  return digest.digest();
}

function lengthFrame(value: string): Buffer {
  const bytes = Buffer.from(value, "utf8");
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32BE(bytes.byteLength);
  return Buffer.concat([length, bytes]);
}

function reference(value: string, maximum: number): boolean {
  if (value.length < 1 || value.length > maximum || value.trim() !== value) {
    throw new Error("ADMISSION_MEDIA_ACCESS_INPUT_INVALID");
  }
  return true;
}

function canonicalInstant(value: string): boolean {
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function instant(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("ADMISSION_MEDIA_ACCESS_ROW_INVALID");
  return date.toISOString();
}
