import type { PlatformTransactionalDatabaseClient } from "../../../../infrastructure/postgres/client.js";
import { resolvePlatformTransaction } from "../../../../shared/unit-of-work/platform-transaction.js";
import type { CapabilityCatalogPublication } from "../crypto/capability-publication-verifier.js";

export interface CapabilityProjectionCommand {
  readonly callerIdentity: string;
  readonly commandId: string;
  readonly idempotencyKey: string;
  readonly requestDigest: string;
  readonly publication: CapabilityCatalogPublication;
}

export interface CapabilityProjectionReceipt {
  readonly agentCatalogRef: string;
  readonly recordedAt: string;
  readonly replayed: boolean;
}

interface CommandRow extends Record<string, unknown> {
  readonly siteId: string;
  readonly commandId: string;
  readonly callerIdentity: string;
  readonly idempotencyKey: string;
  readonly requestDigest: string;
  readonly state: "processing" | "committed";
  readonly agentCatalogRef: string | null;
  readonly recordedAt: string | Date;
}

interface ProjectionRow extends Record<string, unknown> {
  readonly siteId: string;
  readonly siteReleaseRef: string;
  readonly agentCatalogRef: string;
  readonly snapshotDigest: string;
  readonly snapshot: unknown;
  readonly frozenAt: string | Date;
  readonly signingKeyRef: string;
  readonly signatureAlgorithm: string;
  readonly signaturePayloadDigest: string;
  readonly signature: Uint8Array;
}

export class PostgresCapabilityCatalogProjectionRepository {
  readonly #now: () => Date;

  constructor(
    private readonly database: Pick<PlatformTransactionalDatabaseClient, "internalTransaction">,
    options: Readonly<{ now?: () => Date }> = {},
  ) {
    this.#now = options.now ?? (() => new Date());
  }

  project(command: CapabilityProjectionCommand): Promise<CapabilityProjectionReceipt> {
    validateCommand(command);
    return this.database.internalTransaction("capability.projection", async (transaction) => {
      const sql = resolvePlatformTransaction(transaction);
      await sql.query(
        `SELECT set_config('app.site_id',$1,true),set_config('app.caller_identity',$2,true)`,
        [command.publication.siteId, command.callerIdentity],
      );
      const now = this.#instant();
      const inserted = await sql.execute(
        `INSERT INTO platform.capability_projection_command
         (site_id,command_id,caller_identity,idempotency_key,request_digest,state,recorded_at)
         VALUES ($1,$2,$3,$4,$5,'processing',$6::timestamptz)
         ON CONFLICT DO NOTHING`,
        [command.publication.siteId, command.commandId, command.callerIdentity,
          command.idempotencyKey, command.requestDigest, now],
      );
      const row = await loadCommand(sql, command);
      assertSameCommand(row, command);
      if (row.state === "committed") return replay(row, command.publication.agentCatalogRef);
      if (inserted !== 1) throw new Error("CAPABILITY_PROJECTION_COMMAND_IN_PROGRESS");

      const releases = await sql.query<{ agentCatalogRef: string }>(
        `SELECT agent_catalog_ref AS "agentCatalogRef"
           FROM platform.site_release
          WHERE site_ref=$1 AND release_ref=$2 AND state='ready'`,
        [command.publication.siteId, command.publication.siteReleaseRef],
      );
      if (releases.length !== 1 || releases[0]?.agentCatalogRef !== command.publication.agentCatalogRef) {
        throw new Error("CAPABILITY_PROJECTION_SITE_RELEASE_BINDING_MISMATCH");
      }

      const publication = command.publication;
      const projected = await sql.execute(
        `INSERT INTO platform.admission_capability_catalog_snapshot
         (agent_catalog_ref,site_ref,site_release_ref,snapshot_digest,snapshot,published_at,
          frozen_at,signing_key_ref,signature_algorithm,signature_payload_digest,signature)
         VALUES ($1,$2,$3,$4,$5::jsonb,$6::timestamptz,$6::timestamptz,$7,$8,$9,$10)
         ON CONFLICT DO NOTHING`,
        [publication.agentCatalogRef, publication.siteId, publication.siteReleaseRef,
          publication.snapshotDigest, JSON.stringify(publication.snapshot), publication.frozenAt,
          publication.signingKeyRef, publication.signatureAlgorithm,
          publication.signaturePayloadDigest, new Uint8Array(publication.signature)],
      );
      if (projected !== 1) await assertExactProjection(sql, publication);

      const committed = await sql.execute(
        `UPDATE platform.capability_projection_command
            SET state='committed',agent_catalog_ref=$1,updated_at=$2::timestamptz
          WHERE site_id=$3 AND command_id=$4 AND caller_identity=$5
            AND idempotency_key=$6 AND request_digest=$7 AND state='processing'`,
        [publication.agentCatalogRef, now, publication.siteId, command.commandId,
          command.callerIdentity, command.idempotencyKey, command.requestDigest],
      );
      if (committed !== 1) throw new Error("CAPABILITY_PROJECTION_COMMAND_COMMIT_CONFLICT");
      return Object.freeze({ agentCatalogRef: publication.agentCatalogRef, recordedAt: now, replayed: false });
    });
  }

  lookup(input: Readonly<{
    siteId: string;
    callerIdentity: string;
    commandId: string;
    idempotencyKey: string;
    requestDigest: string;
  }>): Promise<CapabilityProjectionReceipt | null> {
    return this.database.internalTransaction("capability.projection", async (transaction) => {
      const sql = resolvePlatformTransaction(transaction);
      await sql.query(
        `SELECT set_config('app.site_id',$1,true),set_config('app.caller_identity',$2,true)`,
        [input.siteId, input.callerIdentity],
      );
      const rows = await sql.query<CommandRow>(
        `${COMMAND_SELECT}
          WHERE site_id=$1 AND command_id=$2 AND caller_identity=$3`,
        [input.siteId, input.commandId, input.callerIdentity],
      );
      const row = rows[0];
      if (row === undefined) return null;
      if (row.idempotencyKey !== input.idempotencyKey || row.requestDigest !== input.requestDigest) {
        throw new Error("CAPABILITY_PROJECTION_COMMAND_CONFLICT");
      }
      if (row.state !== "committed" || row.agentCatalogRef === null) {
        throw new Error("CAPABILITY_PROJECTION_COMMAND_IN_PROGRESS");
      }
      return Object.freeze({
        agentCatalogRef: row.agentCatalogRef,
        recordedAt: instant(row.recordedAt, "CAPABILITY_PROJECTION_RECORDED_AT_INVALID"),
        replayed: true,
      });
    });
  }

  #instant(): string {
    const value = this.#now().getTime();
    if (!Number.isFinite(value)) throw new Error("CAPABILITY_PROJECTION_CLOCK_INVALID");
    return new Date(value).toISOString();
  }
}

const COMMAND_SELECT = `SELECT site_id AS "siteId",command_id AS "commandId",
                               caller_identity AS "callerIdentity",idempotency_key AS "idempotencyKey",
                               request_digest AS "requestDigest",state,
                               agent_catalog_ref AS "agentCatalogRef",recorded_at AS "recordedAt"
                          FROM platform.capability_projection_command`;

async function loadCommand(
  sql: ReturnType<typeof resolvePlatformTransaction>,
  command: CapabilityProjectionCommand,
): Promise<CommandRow> {
  const rows = await sql.query<CommandRow>(
    `${COMMAND_SELECT}
      WHERE site_id=$1 AND caller_identity=$2 AND idempotency_key=$3 FOR UPDATE`,
    [command.publication.siteId, command.callerIdentity, command.idempotencyKey],
  );
  if (rows.length !== 1 || rows[0] === undefined) throw new Error("CAPABILITY_PROJECTION_COMMAND_NOT_FOUND");
  return rows[0];
}

function assertSameCommand(row: CommandRow, command: CapabilityProjectionCommand): void {
  if (row.siteId !== command.publication.siteId || row.commandId !== command.commandId ||
      row.callerIdentity !== command.callerIdentity || row.idempotencyKey !== command.idempotencyKey ||
      row.requestDigest !== command.requestDigest) {
    throw new Error("CAPABILITY_PROJECTION_COMMAND_CONFLICT");
  }
}

function replay(row: CommandRow, expectedAgentCatalogRef: string): CapabilityProjectionReceipt {
  if (row.agentCatalogRef === null || row.agentCatalogRef !== expectedAgentCatalogRef) {
    throw new Error("CAPABILITY_PROJECTION_REPLAY_CONFLICT");
  }
  return Object.freeze({
    agentCatalogRef: row.agentCatalogRef,
    recordedAt: instant(row.recordedAt, "CAPABILITY_PROJECTION_RECORDED_AT_INVALID"),
    replayed: true,
  });
}

async function assertExactProjection(
  sql: ReturnType<typeof resolvePlatformTransaction>,
  publication: CapabilityCatalogPublication,
): Promise<void> {
  const rows = await sql.query<ProjectionRow>(
    `SELECT site_ref AS "siteId",site_release_ref AS "siteReleaseRef",
            agent_catalog_ref AS "agentCatalogRef",snapshot_digest AS "snapshotDigest",snapshot,
            frozen_at AS "frozenAt",signing_key_ref AS "signingKeyRef",
            signature_algorithm AS "signatureAlgorithm",
            signature_payload_digest AS "signaturePayloadDigest",signature
       FROM platform.admission_capability_catalog_snapshot
      WHERE site_ref=$1 AND site_release_ref=$2`,
    [publication.siteId, publication.siteReleaseRef],
  );
  const row = rows[0];
  if (rows.length !== 1 || row === undefined || row.siteId !== publication.siteId ||
      row.siteReleaseRef !== publication.siteReleaseRef || row.agentCatalogRef !== publication.agentCatalogRef ||
      row.snapshotDigest !== publication.snapshotDigest ||
      JSON.stringify(row.snapshot) !== JSON.stringify(publication.snapshot) ||
      instant(row.frozenAt, "CAPABILITY_PROJECTION_FROZEN_AT_INVALID") !==
        instant(publication.frozenAt, "CAPABILITY_PROJECTION_FROZEN_AT_INVALID") ||
      row.signingKeyRef !== publication.signingKeyRef ||
      row.signatureAlgorithm !== publication.signatureAlgorithm ||
      row.signaturePayloadDigest !== publication.signaturePayloadDigest ||
      !Buffer.from(row.signature).equals(Buffer.from(publication.signature))) {
    throw new Error("CAPABILITY_PROJECTION_CONFLICT");
  }
}

function instant(value: string | Date, errorCode: string): string {
  const milliseconds = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw new Error(errorCode);
  return new Date(milliseconds).toISOString();
}

function validateCommand(command: CapabilityProjectionCommand): void {
  if (!/^spiffe:\/\//u.test(command.callerIdentity) || command.commandId.length < 1 ||
      command.commandId.length > 128 || command.idempotencyKey.length < 1 ||
      command.idempotencyKey.length > 191 || !/^[a-f0-9]{64}$/u.test(command.requestDigest)) {
    throw new Error("CAPABILITY_PROJECTION_COMMAND_INVALID");
  }
}
