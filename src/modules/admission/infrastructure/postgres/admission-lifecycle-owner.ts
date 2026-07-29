import { createHash } from "node:crypto";
import type {
  AdmissionAuthorizationRecord,
  AdmissionAuthorizationState,
  AdmissionLifecycleOwnerPort,
} from "../../application/platform-admission-owner-authority.js";
import type { PlatformTransaction } from "../../../../shared/unit-of-work/index.js";
import { resolvePlatformTransaction } from "../../../../shared/unit-of-work/platform-transaction.js";

interface AdmissionLifecycleRow extends Record<string, unknown> {
  readonly siteId: string;
  readonly manifestRef: string;
  readonly manifestDigest: string;
  readonly sessionId: string;
  readonly launchId: string;
  readonly runId: string;
  readonly rootHoldRef: string;
  readonly authorizationSegmentRef: string;
  readonly segmentVersion: bigint | string;
  readonly state: AdmissionAuthorizationState;
  readonly expiresAt: Date | string;
}

interface AdmissionBindingRow extends Record<string, unknown> {
  readonly siteId: string;
  readonly sessionId: string;
  readonly bindingRef: string;
  readonly namespace: string;
  readonly threadId: string;
  readonly capabilitySnapshotRef: string;
  readonly configurationRevisionId: string;
  readonly bindingDigest: string;
}

/**
 * Durable Admission manifest projection. Credit remains the financial segment
 * authority; this owner records the exact segment identity and mirrors its CAS
 * state in the same Platform transaction.
 */
export class PostgresAdmissionLifecycleOwner implements AdmissionLifecycleOwnerPort {
  async prepare(
    transaction: PlatformTransaction,
    input: Parameters<AdmissionLifecycleOwnerPort["prepare"]>[1],
  ): Promise<AdmissionAuthorizationRecord> {
    const sql = resolvePlatformTransaction(transaction);
    const bindingDigest = digest(canonicalJson({
      siteId: input.siteId,
      sessionId: input.effect.sessionId,
      bindingRef: input.sessionExecutionBindingRef,
      namespace: input.ownerFacts.context.namespace,
      threadId: input.ownerFacts.thread_id,
      capabilitySnapshotRef: input.capabilitySnapshotRef,
      configurationRevisionId: input.configurationRevisionId,
    }));
    await sql.execute(
      `INSERT INTO platform.admission_session_execution_binding
       (site_id,session_id,binding_ref,namespace,thread_id,capability_snapshot_ref,
        configuration_revision_id,binding_digest)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (site_id,session_id) DO NOTHING`,
      [input.siteId, input.effect.sessionId, input.sessionExecutionBindingRef,
        input.ownerFacts.context.namespace, input.ownerFacts.thread_id,
        input.capabilitySnapshotRef, input.configurationRevisionId, bindingDigest],
    );
    const bindings = await sql.query<AdmissionBindingRow>(
      `${SELECT_BINDING}
       WHERE site_id=$1 AND session_id=$2 FOR UPDATE`,
      [input.siteId, input.effect.sessionId],
    );
    assertBinding(bindings[0], {
      siteId: input.siteId,
      sessionId: input.effect.sessionId,
      bindingRef: input.sessionExecutionBindingRef,
      namespace: input.ownerFacts.context.namespace,
      threadId: input.ownerFacts.thread_id,
      capabilitySnapshotRef: input.capabilitySnapshotRef,
      configurationRevisionId: input.configurationRevisionId,
      bindingDigest,
    });

    await sql.execute(
      `INSERT INTO platform.admission_execution_manifest
       (site_id,manifest_ref,manifest_digest,session_id,launch_id,run_id,command_id,
        request_digest,trigger_message_id,binding_ref,model_option_revision_ref,resolved_runtime,
        execution_budget_root_ref,root_hold_ref,authorization_segment_ref,segment_version,
        expires_at,maximum_expires_at,capability_snapshot_ref,configuration_revision_id,
        attachment_refs,state)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14,$15,$16,
         $17::timestamptz,$18::timestamptz,$19,$20,$21::jsonb,'reserved')
       ON CONFLICT (site_id,launch_id) DO NOTHING`,
      [input.siteId, input.manifestRef, input.manifestDigest, input.effect.sessionId,
        input.effect.launchId, input.effect.proposedRunId, input.commandId, input.requestDigest,
        input.effect.triggerMessageId, input.sessionExecutionBindingRef,
        input.effect.modelOptionRevisionRef, canonicalJson(input.ownerFacts.runtime),
        input.executionBudgetRootRef, input.rootHoldRef, input.authorizationSegmentRef,
        input.segmentVersion.toString(), input.expiresAt, input.maximumExpiresAt,
        input.capabilitySnapshotRef, input.configurationRevisionId,
        canonicalJson(input.effect.attachmentRefs.map((item) => ({
          assetRef: item.assetRef,
          assetVersionRef: item.assetVersionRef,
          assetGrantRef: item.assetGrantRef,
        })))],
    );
    const record = await findManifest(transaction, {
      siteId: input.siteId,
      manifestRef: input.manifestRef,
      authorizationSegmentRef: input.authorizationSegmentRef,
    }, true);
    if (record === null) throw new Error("ADMISSION_LIFECYCLE_PREPARE_INCOMPLETE");
    assertPrepared(record, input);
    return record;
  }

  read(
    transaction: PlatformTransaction,
    input: Parameters<AdmissionLifecycleOwnerPort["read"]>[1],
  ): Promise<AdmissionAuthorizationRecord | null> {
    return findManifest(transaction, input, false);
  }

  lock(
    transaction: PlatformTransaction,
    input: Parameters<AdmissionLifecycleOwnerPort["lock"]>[1],
  ): Promise<AdmissionAuthorizationRecord | null> {
    return findManifest(transaction, input, true);
  }

  commit(transaction: PlatformTransaction, record: AdmissionAuthorizationRecord) {
    return transition(transaction, record, "committed");
  }

  expire(transaction: PlatformTransaction, record: AdmissionAuthorizationRecord) {
    return transition(transaction, record, "expired");
  }

  release(
    transaction: PlatformTransaction,
    record: AdmissionAuthorizationRecord,
    evidence: Parameters<AdmissionLifecycleOwnerPort["release"]>[2],
  ) {
    if (
      evidence.siteId !== record.siteId ||
      evidence.authorizationSegmentRef !== record.authorizationSegmentRef ||
      evidence.authorizationSegmentVersion !== record.segmentVersion.toString()
    ) throw new Error("ADMISSION_LIFECYCLE_EVIDENCE_MISMATCH");
    return transition(transaction, record, "released", evidence.evidenceRef);
  }

  requireReconciliation(transaction: PlatformTransaction, record: AdmissionAuthorizationRecord) {
    return transition(transaction, record, "reconciliation_required");
  }

  settle(transaction: PlatformTransaction, record: AdmissionAuthorizationRecord) {
    return transition(transaction, record, "settled");
  }
}

async function findManifest(
  transaction: PlatformTransaction,
  input: Readonly<{ siteId: string; manifestRef: string; authorizationSegmentRef: string }>,
  lock: boolean,
): Promise<AdmissionAuthorizationRecord | null> {
  const rows = await resolvePlatformTransaction(transaction).query<AdmissionLifecycleRow>(
    `${SELECT_MANIFEST}
     WHERE site_id=$1 AND manifest_ref=$2 AND authorization_segment_ref=$3${lock ? " FOR UPDATE" : ""}`,
    [input.siteId, input.manifestRef, input.authorizationSegmentRef],
  );
  if (rows.length > 1) throw new Error("ADMISSION_LIFECYCLE_IDENTITY_AMBIGUOUS");
  return rows[0] === undefined ? null : record(rows[0]);
}

async function transition(
  transaction: PlatformTransaction,
  prior: AdmissionAuthorizationRecord,
  state: Exclude<AdmissionAuthorizationState, "reserved">,
  resolutionRef?: string,
): Promise<AdmissionAuthorizationRecord> {
  const sql = resolvePlatformTransaction(transaction);
  const changed = await sql.execute(
    `UPDATE platform.admission_execution_manifest
     SET state=$1,segment_version=$2,resolution_ref=$3,updated_at=now()
     WHERE site_id=$4 AND manifest_ref=$5 AND authorization_segment_ref=$6
       AND state=$7 AND segment_version=$8`,
    [state, (prior.segmentVersion + 1n).toString(), resolutionRef ?? null,
      prior.siteId, prior.manifestRef, prior.authorizationSegmentRef, prior.state,
      prior.segmentVersion.toString()],
  );
  if (changed !== 1) throw new Error("ADMISSION_LIFECYCLE_CAS_LOST");
  const next = await findManifest(transaction, prior, true);
  if (
    next === null || next.state !== state || next.segmentVersion !== prior.segmentVersion + 1n ||
    !sameIdentity(next, prior)
  ) throw new Error("ADMISSION_LIFECYCLE_TRANSITION_INVALID");
  return next;
}

function record(row: AdmissionLifecycleRow): AdmissionAuthorizationRecord {
  if (!STATES.has(row.state)) throw new Error("ADMISSION_LIFECYCLE_ROW_INVALID");
  const expiresAt = instant(row.expiresAt);
  const segmentVersion = BigInt(row.segmentVersion);
  if (segmentVersion < 1n) throw new Error("ADMISSION_LIFECYCLE_ROW_INVALID");
  return Object.freeze({
    siteId: reference(row.siteId),
    manifestRef: reference(row.manifestRef),
    manifestDigest: hexDigest(row.manifestDigest),
    sessionId: reference(row.sessionId),
    launchId: reference(row.launchId),
    runId: reference(row.runId),
    rootHoldRef: reference(row.rootHoldRef),
    authorizationSegmentRef: reference(row.authorizationSegmentRef),
    segmentVersion,
    state: row.state,
    expiresAt,
  });
}

function assertBinding(actual: AdmissionBindingRow | undefined, expected: AdmissionBindingRow): void {
  if (
    actual === undefined || actual.siteId !== expected.siteId || actual.sessionId !== expected.sessionId ||
    actual.bindingRef !== expected.bindingRef || actual.namespace !== expected.namespace ||
    actual.threadId !== expected.threadId ||
    actual.capabilitySnapshotRef !== expected.capabilitySnapshotRef ||
    actual.configurationRevisionId !== expected.configurationRevisionId ||
    actual.bindingDigest !== expected.bindingDigest
  ) throw new Error("ADMISSION_SESSION_BINDING_CONFLICT");
}

function assertPrepared(
  actual: AdmissionAuthorizationRecord,
  input: Parameters<AdmissionLifecycleOwnerPort["prepare"]>[1],
): void {
  if (
    actual.siteId !== input.siteId || actual.manifestRef !== input.manifestRef ||
    actual.manifestDigest !== input.manifestDigest || actual.sessionId !== input.effect.sessionId ||
    actual.launchId !== input.effect.launchId || actual.runId !== input.effect.proposedRunId ||
    actual.rootHoldRef !== input.rootHoldRef ||
    actual.authorizationSegmentRef !== input.authorizationSegmentRef ||
    actual.segmentVersion !== input.segmentVersion || actual.state !== "reserved" ||
    actual.expiresAt !== input.expiresAt
  ) throw new Error("ADMISSION_LIFECYCLE_PREPARE_CONFLICT");
}

function sameIdentity(left: AdmissionAuthorizationRecord, right: AdmissionAuthorizationRecord): boolean {
  return left.siteId === right.siteId && left.manifestRef === right.manifestRef &&
    left.manifestDigest === right.manifestDigest && left.sessionId === right.sessionId &&
    left.launchId === right.launchId && left.runId === right.runId &&
    left.rootHoldRef === right.rootHoldRef &&
    left.authorizationSegmentRef === right.authorizationSegmentRef &&
    left.expiresAt === right.expiresAt;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
    .join(",")}}`;
}

function reference(value: string): string {
  if (value.length < 1 || value.length > 256 || value.trim() !== value) {
    throw new Error("ADMISSION_LIFECYCLE_ROW_INVALID");
  }
  return value;
}

function hexDigest(value: string): string {
  if (!/^[0-9a-f]{64}$/u.test(value)) throw new Error("ADMISSION_LIFECYCLE_ROW_INVALID");
  return value;
}

function instant(value: Date | string): string {
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error("ADMISSION_LIFECYCLE_ROW_INVALID");
  return parsed.toISOString();
}

const STATES = new Set<AdmissionAuthorizationState>([
  "reserved", "committed", "released", "expired", "reconciliation_required", "settled",
]);

const SELECT_BINDING = `SELECT site_id AS "siteId",session_id AS "sessionId",
  binding_ref AS "bindingRef",namespace,thread_id AS "threadId",
  capability_snapshot_ref AS "capabilitySnapshotRef",
  configuration_revision_id AS "configurationRevisionId",binding_digest AS "bindingDigest"
  FROM platform.admission_session_execution_binding`;

const SELECT_MANIFEST = `SELECT site_id AS "siteId",manifest_ref AS "manifestRef",
  manifest_digest AS "manifestDigest",session_id AS "sessionId",launch_id AS "launchId",
  run_id AS "runId",root_hold_ref AS "rootHoldRef",
  authorization_segment_ref AS "authorizationSegmentRef",segment_version AS "segmentVersion",
  state,expires_at AS "expiresAt"
  FROM platform.admission_execution_manifest`;
