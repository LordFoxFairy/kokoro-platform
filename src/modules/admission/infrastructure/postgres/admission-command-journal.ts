import { createHash, randomUUID } from "node:crypto";
import type { PlatformTransactionalDatabaseClient } from "../../../../infrastructure/postgres/client.js";
import type { PlatformTransaction } from "../../../../shared/unit-of-work/platform-transaction.js";
import { resolvePlatformTransaction } from "../../../../shared/unit-of-work/platform-transaction.js";
import type {
  AdmissionCommandJournal,
  AdmissionCommandKey,
  AdmissionJournalBegin,
  AdmissionJournalLookup,
  AdmissionReceiptLookup,
} from "../../application/admission-ports.js";

const MAX_RESPONSE_BYTES = 1024 * 1024;

interface AdmissionCommandRow extends Record<string, unknown> {
  readonly siteId: string;
  readonly operation: string;
  readonly commandId: string;
  readonly environment: string;
  readonly region: string;
  readonly callerIdentity: string;
  readonly idempotencyKey: string;
  readonly requestDigest: string;
  readonly state: "processing" | "completed";
  readonly leaseToken: string | null;
  readonly leaseExpired: boolean;
  readonly responsePayload: Uint8Array | null;
  readonly responseDigest: string | null;
  readonly recordedAt: string;
}

/** PostgreSQL-backed exact-response journal for Admission's ambiguous-effect protocol. */
export class PostgresAdmissionCommandJournal implements AdmissionCommandJournal {
  readonly #database: Pick<PlatformTransactionalDatabaseClient, "internalTransaction">;
  readonly #leaseMs: number;
  readonly #clock: () => Date;

  constructor(
    database: Pick<PlatformTransactionalDatabaseClient, "internalTransaction">,
    options: Readonly<{ leaseMs?: number; clock?: () => Date }> = {},
  ) {
    this.#database = database;
    this.#leaseMs = options.leaseMs ?? 30_000;
    this.#clock = options.clock ?? (() => new Date());
    if (!Number.isInteger(this.#leaseMs) || this.#leaseMs < 5_000 || this.#leaseMs > 120_000) {
      throw new Error("ADMISSION_JOURNAL_LEASE_INVALID");
    }
  }

  async begin(command: AdmissionCommandKey): Promise<AdmissionJournalBegin> {
    const now = this.#now();
    const leaseToken = randomUUID();
    const leaseExpiresAt = new Date(Date.parse(now) + this.#leaseMs).toISOString();
    return this.#database.internalTransaction("admission.command", async (transaction) => {
      const sql = await scoped(transaction, command);
      await sql.execute(
        `INSERT INTO platform.admission_command
         (site_id, operation, command_id, environment, region, caller_identity,
          idempotency_key, request_digest, lease_token, lease_expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::uuid,$10::timestamptz)
         ON CONFLICT (environment, caller_identity, site_id, operation, idempotency_key)
         DO NOTHING`,
        [command.siteId, command.operation, command.commandId, command.environment,
          command.region, command.identity, command.idempotencyKey, command.requestDigest,
          leaseToken, leaseExpiresAt],
      );
      let row = await findByIdempotency(transaction, command);
      assertSameCommand(row, command);
      if (row.state === "completed") return replay(row);
      if (row.leaseToken === leaseToken) return Object.freeze({ kind: "started", leaseToken });
      if (!row.leaseExpired) {
        return Object.freeze({ kind: "pending", recordedAt: row.recordedAt });
      }
      const updated = await sql.execute(
        `UPDATE platform.admission_command
         SET lease_token=$1::uuid, lease_expires_at=$2::timestamptz, updated_at=$3::timestamptz
         WHERE site_id=$4 AND operation=$5 AND command_id=$6 AND state='processing'
           AND lease_token=$7::uuid AND lease_expires_at <= $3::timestamptz`,
        [leaseToken, leaseExpiresAt, now, command.siteId, command.operation, command.commandId,
          row.leaseToken],
      );
      if (updated === 1) return Object.freeze({ kind: "started", leaseToken });
      row = await findByIdempotency(transaction, command);
      assertSameCommand(row, command);
      return row.state === "completed"
        ? replay(row)
        : Object.freeze({ kind: "pending", recordedAt: row.recordedAt });
    });
  }

  async complete(
    command: AdmissionCommandKey,
    leaseToken: string,
    response: Uint8Array,
  ): Promise<Uint8Array> {
    if (
      !(response instanceof Uint8Array) || response.byteLength < 1 ||
      response.byteLength > MAX_RESPONSE_BYTES
    ) throw new Error("ADMISSION_RESPONSE_SIZE_INVALID");
    const owned = new Uint8Array(response);
    const responseDigest = sha256(owned);
    const now = this.#now();
    return this.#database.internalTransaction("admission.command", async (transaction) => {
      const sql = await scoped(transaction, command);
      const updated = await sql.execute(
        `UPDATE platform.admission_command
         SET state='completed', response_payload=$1, response_digest=$2,
             lease_token=NULL, lease_expires_at=NULL, updated_at=$3::timestamptz
         WHERE site_id=$4 AND operation=$5 AND command_id=$6
           AND request_digest=$7 AND state='processing' AND lease_token=$8::uuid
           AND lease_expires_at > $3::timestamptz`,
        [owned, responseDigest, now, command.siteId, command.operation, command.commandId,
          command.requestDigest, leaseToken],
      );
      if (updated === 1) return owned;
      const row = await findByIdempotency(transaction, command);
      assertSameCommand(row, command);
      if (
        row.state === "completed" && row.responsePayload !== null &&
        row.responseDigest === responseDigest && sha256(row.responsePayload) === responseDigest
      ) return new Uint8Array(row.responsePayload);
      throw new Error("ADMISSION_COMMAND_LEASE_LOST");
    });
  }

  async lookup(query: AdmissionReceiptLookup): Promise<AdmissionJournalLookup> {
    return this.#database.internalTransaction("admission.command", async (transaction) => {
      const sql = await scoped(transaction, query);
      const rows = await sql.query<AdmissionCommandRow>(
        `${SELECT_ROW}
         WHERE site_id=$1 AND operation=$2 AND command_id=$3
           AND environment=$4 AND region=$5 AND caller_identity=$6`,
        [query.siteId, query.operation, query.commandId, query.environment, query.region,
          query.identity],
      );
      const row = rows[0];
      if (row === undefined) return Object.freeze({ kind: "not_found" });
      if (row.requestDigest !== query.requestDigest) throw new Error("ADMISSION_COMMAND_CONFLICT");
      if (row.state === "processing") return Object.freeze({
        kind: "pending",
        idempotencyKey: row.idempotencyKey,
        recordedAt: row.recordedAt,
      });
      const restored = replay(row);
      return Object.freeze({ kind: "found", response: restored.response });
    });
  }

  #now(): string {
    const value = this.#clock().getTime();
    if (!Number.isFinite(value)) throw new Error("ADMISSION_CLOCK_INVALID");
    return new Date(value).toISOString();
  }
}

async function scoped(
  transaction: PlatformTransaction,
  input: Readonly<{ siteId: string; identity: string }>,
) {
  const sql = resolvePlatformTransaction(transaction);
  await sql.query(
    `SELECT set_config('app.site_id',$1,true), set_config('app.caller_identity',$2,true)`,
    [input.siteId, input.identity],
  );
  return sql;
}

async function findByIdempotency(
  transaction: PlatformTransaction,
  command: AdmissionCommandKey,
): Promise<AdmissionCommandRow> {
  const rows = await resolvePlatformTransaction(transaction).query<AdmissionCommandRow>(
    `${SELECT_ROW}
     WHERE environment=$1 AND caller_identity=$2 AND site_id=$3
       AND operation=$4 AND idempotency_key=$5
     FOR UPDATE`,
    [command.environment, command.identity, command.siteId, command.operation,
      command.idempotencyKey],
  );
  const row = rows[0];
  if (row === undefined) throw new Error("ADMISSION_COMMAND_NOT_FOUND");
  return row;
}

function assertSameCommand(row: AdmissionCommandRow, command: AdmissionCommandKey): void {
  if (
    row.siteId !== command.siteId || row.operation !== command.operation ||
    row.commandId !== command.commandId || row.environment !== command.environment ||
    row.region !== command.region || row.callerIdentity !== command.identity ||
    row.idempotencyKey !== command.idempotencyKey || row.requestDigest !== command.requestDigest
  ) throw new Error("ADMISSION_COMMAND_CONFLICT");
}

function replay(row: AdmissionCommandRow): Readonly<{ kind: "replay"; response: Uint8Array }> {
  if (
    row.state !== "completed" || row.responsePayload === null || row.responseDigest === null ||
    row.responsePayload.byteLength < 1 || row.responsePayload.byteLength > MAX_RESPONSE_BYTES ||
    sha256(row.responsePayload) !== row.responseDigest
  ) throw new Error("ADMISSION_COMMAND_JOURNAL_CORRUPT");
  return Object.freeze({ kind: "replay", response: new Uint8Array(row.responsePayload) });
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

const SELECT_ROW = `SELECT site_id AS "siteId", operation, command_id AS "commandId",
  environment, region, caller_identity AS "callerIdentity",
  idempotency_key AS "idempotencyKey", request_digest AS "requestDigest", state,
  lease_token::text AS "leaseToken", lease_expires_at <= now() AS "leaseExpired",
  response_payload AS "responsePayload", response_digest AS "responseDigest",
  to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "recordedAt"
  FROM platform.admission_command`;
