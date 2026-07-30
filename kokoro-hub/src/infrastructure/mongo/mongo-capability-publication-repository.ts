import { MongoServerError } from "mongodb";
import type {
  CapabilityCatalogPublicationRecord,
  CapabilityProjectionDelivery,
  CapabilityPublicationRepository,
  FreezeCapabilityCatalogCommand,
} from "../../domain/capability-publication-repository.js";
import type { CapabilityPublicationRecord, HubCollections } from "./mongo-client.js";

export class MongoCapabilityPublicationRepository implements CapabilityPublicationRepository {
  #indexed = false;

  constructor(private readonly collections: HubCollections) {}

  async freeze(command: FreezeCapabilityCatalogCommand): Promise<CapabilityCatalogPublicationRecord> {
    await this.#ensureIndexes();
    const recordedAt = command.publication.frozenAt;
    const row: CapabilityPublicationRecord = {
      site_id: command.publication.siteId,
      site_release_ref: command.publication.siteReleaseRef,
      command_id: command.commandId,
      idempotency_key: command.idempotencyKey,
      request_digest: command.requestDigest,
      agent_catalog_ref: command.publication.agentCatalogRef,
      snapshot_digest: command.publication.snapshotDigest,
      snapshot: command.publication.snapshot,
      frozen_at: command.publication.frozenAt,
      signing_key_ref: command.publication.signingKeyRef,
      signature_algorithm: command.publication.signatureAlgorithm,
      signature_payload_digest: command.publication.signaturePayloadDigest,
      signature: new Uint8Array(command.publication.signature),
      recorded_at: recordedAt,
      projection_state: "pending",
      projection_attempt: 0,
      projection_next_attempt_at: recordedAt,
      projection_lease_id: null,
      projection_lease_until: null,
      projected_at: null,
      last_projection_error_code: null,
    };
    try {
      await this.collections.capabilityPublications.insertOne(row);
      return map(row, false);
    } catch (error) {
      if (!(error instanceof MongoServerError) || error.code !== 11_000) throw error;
      const existing = await this.collections.capabilityPublications.findOne({
        $or: [
          { command_id: command.commandId },
          { site_id: command.publication.siteId, idempotency_key: command.idempotencyKey },
          { site_id: command.publication.siteId, site_release_ref: command.publication.siteReleaseRef },
        ],
      });
      if (existing === null || !sameCommand(existing, row)) {
        throw new Error("HUB_CAPABILITY_CATALOG_COMMAND_CONFLICT");
      }
      return map(existing, true);
    }
  }

  async get(input: Readonly<{
    commandId: string;
    idempotencyKey: string;
    requestDigest: string;
    siteId: string;
    siteReleaseRef: string;
  }>): Promise<CapabilityCatalogPublicationRecord | null> {
    await this.#ensureIndexes();
    const row = await this.collections.capabilityPublications.findOne({ command_id: input.commandId });
    if (row === null) return null;
    if (row.site_id !== input.siteId || row.site_release_ref !== input.siteReleaseRef ||
        row.idempotency_key !== input.idempotencyKey || row.request_digest !== input.requestDigest) {
      throw new Error("HUB_CAPABILITY_CATALOG_COMMAND_CONFLICT");
    }
    return map(row, true);
  }

  async claimProjection(input: Readonly<{
    leaseId: string;
    now: string;
    leaseUntil: string;
  }>): Promise<CapabilityProjectionDelivery | null> {
    await this.#ensureIndexes();
    const row = await this.collections.capabilityPublications.findOneAndUpdate(
      {
        projection_state: { $in: ["pending", "outcome_unknown"] },
        projection_next_attempt_at: { $lte: input.now },
        $or: [
          { projection_lease_until: null },
          { projection_lease_until: { $lte: input.now } },
        ],
      },
      {
        $set: { projection_lease_id: input.leaseId, projection_lease_until: input.leaseUntil },
        $inc: { projection_attempt: 1 },
      },
      { sort: { projection_next_attempt_at: 1, recorded_at: 1 }, returnDocument: "after" },
    );
    if (row === null) return null;
    return Object.freeze({ ...map(row, false), leaseId: input.leaseId, attempt: row.projection_attempt });
  }

  async completeProjection(input: Readonly<{
    siteId: string;
    siteReleaseRef: string;
    leaseId: string;
    projectedAt: string;
  }>): Promise<void> {
    const result = await this.collections.capabilityPublications.updateOne(
      {
        site_id: input.siteId,
        site_release_ref: input.siteReleaseRef,
        projection_lease_id: input.leaseId,
        projection_state: { $in: ["pending", "outcome_unknown"] },
      },
      { $set: {
        projection_state: "committed",
        projected_at: input.projectedAt,
        projection_lease_id: null,
        projection_lease_until: null,
        last_projection_error_code: null,
      } },
    );
    if (result.modifiedCount !== 1) throw new Error("HUB_CAPABILITY_PROJECTION_LEASE_LOST");
  }

  async deferProjection(input: Readonly<{
    siteId: string;
    siteReleaseRef: string;
    leaseId: string;
    state: "outcome_unknown" | "rejected";
    errorCode: string;
    nextAttemptAt?: string;
  }>): Promise<void> {
    const result = await this.collections.capabilityPublications.updateOne(
      {
        site_id: input.siteId,
        site_release_ref: input.siteReleaseRef,
        projection_lease_id: input.leaseId,
        projection_state: { $in: ["pending", "outcome_unknown"] },
      },
      { $set: {
        projection_state: input.state,
        projection_lease_id: null,
        projection_lease_until: null,
        last_projection_error_code: input.errorCode,
        ...(input.nextAttemptAt === undefined ? {} : { projection_next_attempt_at: input.nextAttemptAt }),
      } },
    );
    if (result.modifiedCount !== 1) throw new Error("HUB_CAPABILITY_PROJECTION_LEASE_LOST");
  }

  async #ensureIndexes(): Promise<void> {
    if (this.#indexed) return;
    await Promise.all([
      this.collections.capabilityPublications.createIndex({ command_id: 1 }, { unique: true }),
      this.collections.capabilityPublications.createIndex(
        { site_id: 1, idempotency_key: 1 },
        { unique: true },
      ),
      this.collections.capabilityPublications.createIndex(
        { site_id: 1, site_release_ref: 1 },
        { unique: true },
      ),
      this.collections.capabilityPublications.createIndex({
        projection_state: 1,
        projection_next_attempt_at: 1,
        projection_lease_until: 1,
      }),
    ]);
    this.#indexed = true;
  }
}

function sameCommand(left: CapabilityPublicationRecord, right: CapabilityPublicationRecord): boolean {
  return left.command_id === right.command_id && left.site_id === right.site_id &&
    left.site_release_ref === right.site_release_ref && left.idempotency_key === right.idempotency_key &&
    left.request_digest === right.request_digest;
}

function map(row: CapabilityPublicationRecord, replayed: boolean): CapabilityCatalogPublicationRecord {
  return Object.freeze({
    commandId: row.command_id,
    idempotencyKey: row.idempotency_key,
    requestDigest: row.request_digest,
    publication: Object.freeze({
      siteId: row.site_id,
      siteReleaseRef: row.site_release_ref,
      agentCatalogRef: row.agent_catalog_ref,
      snapshotDigest: row.snapshot_digest,
      snapshot: row.snapshot,
      frozenAt: row.frozen_at,
      signingKeyRef: row.signing_key_ref,
      signatureAlgorithm: row.signature_algorithm,
      signaturePayloadDigest: row.signature_payload_digest,
      signature: signatureBytes(row.signature),
    }),
    recordedAt: row.recorded_at,
    projectionState: row.projection_state,
    ...(row.last_projection_error_code === null
      ? {} : { lastProjectionErrorCode: row.last_projection_error_code }),
    replayed,
  });
}

function signatureBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) {
    if (value.byteLength !== 64) throw new Error("HUB_CAPABILITY_CATALOG_SIGNATURE_INVALID");
    return new Uint8Array(value);
  }
  if (value !== null && typeof value === "object" && "buffer" in value) {
    const buffer = (value as { buffer: unknown }).buffer;
    if (buffer instanceof Uint8Array && buffer.byteLength === 64) return new Uint8Array(buffer);
  }
  throw new Error("HUB_CAPABILITY_CATALOG_SIGNATURE_INVALID");
}
