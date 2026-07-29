import { createHash } from "node:crypto";
import { AdmissionRetryClass } from "../../../../interfaces/connect/generated/kokoro/platform/admission/v1/admission_pb.js";
import { resolvePlatformTransaction } from "../../../../shared/unit-of-work/platform-transaction.js";
import type {
  AdmissionExecutionBindingOwnerPort,
  AdmissionOwnerResolution,
} from "../../application/platform-admission-owner-authority.js";

interface BindingAuthorityRow extends Record<string, unknown> {
  readonly siteId: unknown;
  readonly projectRef: unknown;
  readonly namespace: unknown;
  readonly executionSpaceRef: unknown;
  readonly namespaceSecurityEpoch: unknown;
}

interface BindingRow extends Record<string, unknown> {
  readonly bindingRef: unknown;
  readonly namespace: unknown;
  readonly threadId: unknown;
  readonly capabilitySnapshotRef: unknown;
  readonly configurationRevisionId: unknown;
  readonly bindingDigest: unknown;
}

/** Platform IdentityExecutionSpace is the sole owner of GA's opaque namespace. */
export class PostgresAdmissionExecutionBindingOwner implements AdmissionExecutionBindingOwnerPort {
  async resolve(
    transaction: Parameters<AdmissionExecutionBindingOwnerPort["resolve"]>[0],
    input: Parameters<AdmissionExecutionBindingOwnerPort["resolve"]>[1],
  ): ReturnType<AdmissionExecutionBindingOwnerPort["resolve"]> {
    const sql = resolvePlatformTransaction(transaction);
    const rows = await sql.query<BindingAuthorityRow>(
      `SELECT space.site_ref AS "siteId",space.project_ref AS "projectRef",
              space.execution_namespace AS namespace,
              space.execution_space_ref AS "executionSpaceRef",
              space.security_epoch AS "namespaceSecurityEpoch"
         FROM platform.identity_execution_space AS space
         JOIN platform.identity_namespace_allocation_intent AS allocation
           ON allocation.site_ref=space.site_ref
          AND allocation.execution_space_ref=space.execution_space_ref
          AND allocation.execution_namespace=space.execution_namespace
          AND allocation.state='applied'
        WHERE space.site_ref=$1 AND space.project_ref=$2 AND space.state='active'
        LIMIT 2
        FOR SHARE OF space,allocation`,
      [input.siteId, input.projectRef],
    );
    if (rows.length > 1) throw new Error("ADMISSION_EXECUTION_SPACE_AMBIGUOUS");
    const row = rows[0];
    if (row === undefined) return denied("ADMISSION_EXECUTION_SPACE_NOT_READY", AdmissionRetryClass.AFTER_DELAY);
    if (
      row.siteId !== input.siteId || row.projectRef !== input.projectRef ||
      !namespace(row.namespace) || !ownerRef(row.executionSpaceRef) ||
      !positiveBigint(row.namespaceSecurityEpoch)
    ) throw new Error("ADMISSION_EXECUTION_SPACE_CORRUPT");
    const bindingDigest = digest({
      siteId: input.siteId,
      sessionId: input.sessionId,
      namespace: row.namespace,
      executionSpaceRef: row.executionSpaceRef,
      namespaceSecurityEpoch: BigInt(row.namespaceSecurityEpoch as bigint | string | number).toString(),
      threadId: input.threadId,
      capabilitySnapshotRef: input.capabilitySnapshotRef,
      configurationRevisionId: input.configurationRevisionId,
    });
    const bindingRef = `session-execution-binding:sha256:${bindingDigest}`;
    await sql.execute(
      `INSERT INTO platform.admission_session_execution_binding
       (site_id,session_id,binding_ref,namespace,thread_id,capability_snapshot_ref,
        configuration_revision_id,binding_digest)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (site_id,session_id) DO NOTHING`,
      [input.siteId,input.sessionId,bindingRef,row.namespace,input.threadId,
        input.capabilitySnapshotRef,input.configurationRevisionId,bindingDigest],
    );
    const bindingRows = await sql.query<BindingRow>(
      `SELECT binding_ref AS "bindingRef",namespace,thread_id AS "threadId",
              capability_snapshot_ref AS "capabilitySnapshotRef",
              configuration_revision_id AS "configurationRevisionId",
              binding_digest AS "bindingDigest"
         FROM platform.admission_session_execution_binding
        WHERE site_id=$1 AND session_id=$2
        LIMIT 2
        FOR SHARE`,
      [input.siteId,input.sessionId],
    );
    if (bindingRows.length !== 1) throw new Error("ADMISSION_SESSION_BINDING_CORRUPT");
    const binding = bindingRows[0]!;
    if (
      binding.bindingRef !== bindingRef || binding.namespace !== row.namespace ||
      binding.threadId !== input.threadId ||
      binding.capabilitySnapshotRef !== input.capabilitySnapshotRef ||
      binding.configurationRevisionId !== input.configurationRevisionId ||
      binding.bindingDigest !== bindingDigest
    ) return denied("ADMISSION_SESSION_BINDING_CONFLICT", AdmissionRetryClass.NEVER);
    return Object.freeze({
      kind: "resolved",
      value: Object.freeze({ namespace: row.namespace, sessionExecutionBindingRef: bindingRef }),
    });
  }
}

function denied(code: string, retryClass: AdmissionRetryClass): AdmissionOwnerResolution<never> {
  return Object.freeze({ kind: "denied", denial: Object.freeze({ code, retryClass }) });
}

function namespace(value: unknown): value is string {
  return typeof value === "string" && value.length >= 32 && value.length <= 128 && value.trim() === value;
}

function ownerRef(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && value.trim() === value;
}

function positiveBigint(value: unknown): boolean {
  try { return BigInt(value as bigint | string | number) > 0n; } catch { return false; }
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(",")}}`;
}
