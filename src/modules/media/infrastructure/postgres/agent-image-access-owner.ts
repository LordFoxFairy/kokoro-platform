import { createHash, createHmac } from "node:crypto";
import type { AgentImageAccessOwnerPort, MediaImageAdmissionFacts } from "../../application/index.js";

export type ResolvedAgentImageAccessRow = Readonly<{
  siteRef: string;
  projectRef: string;
  sessionRef: string;
  runRef: string;
  subjectRef: string;
  subjectGeneration: bigint | string;
  configurationRevisionRef: string;
  executionBudgetRootRef: string;
  authorizationSegmentRef: string;
  executionManifestRef: string;
  parentAllocationRef: string;
  maximumCredit: bigint | string;
  trustInputDecisionRef: string;
  expectedParentRevision: bigint | string;
  expectedParentAllocationEpoch: bigint | string;
  creditSurfaceRef: string;
  creditCapabilityKey: string;
  creditAgentRef: string | null;
  creditUnit: string;
  creditExpiresAt: Date | string;
  definitionRevisionRef: string;
  modelOptionRevisionRef: string;
}>;

/** Narrow database authority implemented by the isolated Media Runtime credential. */
export interface AgentImageAccessDatabase {
  resolveAgentImageAccess(input: Readonly<{
    handleDigest: string;
    projectionReservationDigest: string;
  }>): Promise<readonly ResolvedAgentImageAccessRow[]>;
}

/**
 * Resolves both opaque Admission handles through the PostgreSQL security-definer
 * authority. No Site, identity, release, model, or Credit selector is accepted
 * from GA.
 */
export class PostgresAgentImageAccessOwner implements AgentImageAccessOwnerPort {
  readonly #key: Buffer;

  constructor(private readonly dependencies: Readonly<{
    database: AgentImageAccessDatabase;
    mediaAccessKey: Uint8Array;
  }>) {
    if (dependencies.mediaAccessKey.byteLength !== 32) {
      throw new Error("MEDIA_ACCESS_KEY_INVALID");
    }
    this.#key = Buffer.from(dependencies.mediaAccessKey);
  }

  async resolveAgentImage(
    input: Parameters<AgentImageAccessOwnerPort["resolveAgentImage"]>[0],
    signal: AbortSignal,
  ): Promise<MediaImageAdmissionFacts> {
    if (signal.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
    opaqueHandle(input.mediaAccessHandle);
    opaqueHandle(input.mediaProjectionReservationHandle);
    reference(input.stableOutputSlotRef, 8192);
    reference(input.agentMediaCommandRef, 8192);
    const accessAuthorizationHandleDigest = createHash("sha256")
      .update(input.mediaAccessHandle).digest("hex");
    const projectionReservationDigest = createHmac("sha256", this.#key)
        .update("kokoro.platform.media-projection-reservation-handle.v1\0")
        .update(lengthFrame(input.mediaProjectionReservationHandle))
        .digest("hex");
    const rows = await this.dependencies.database.resolveAgentImageAccess({
      handleDigest: accessAuthorizationHandleDigest,
      projectionReservationDigest,
    });
    if (signal.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
    if (rows.length !== 1) throw new Error("MEDIA_ACCESS_DENIED");
    return facts(rows[0]!, input, Object.freeze({
      accessAuthorizationHandleDigest,
      projectionReservationDigest,
    }));
  }
}

function facts(
  row: ResolvedAgentImageAccessRow,
  input: Parameters<AgentImageAccessOwnerPort["resolveAgentImage"]>[0],
  authorization: Readonly<{
    accessAuthorizationHandleDigest: string;
    projectionReservationDigest: string;
  }>,
): MediaImageAdmissionFacts {
  const subjectGeneration = exactPositiveBigInt(row.subjectGeneration);
  const maximumCredit = exactPositiveBigInt(row.maximumCredit);
  const expectedParentRevision = exactPositiveBigInt(row.expectedParentRevision);
  const expectedParentAllocationEpoch = exactPositiveBigInt(row.expectedParentAllocationEpoch);
  for (const value of [row.siteRef, row.projectRef, row.sessionRef, row.runRef, row.subjectRef,
    row.configurationRevisionRef, row.executionBudgetRootRef, row.authorizationSegmentRef,
    row.executionManifestRef,
    row.parentAllocationRef, row.trustInputDecisionRef, row.definitionRevisionRef,
    row.modelOptionRevisionRef, row.creditSurfaceRef, row.creditCapabilityKey, row.creditUnit]) reference(value);
  if (row.creditAgentRef !== null) reference(row.creditAgentRef);
  const expiresAt = instant(row.creditExpiresAt);
  const workloadRef = `agent-media-workload:sha256:${createHash("sha256")
    .update("kokoro.platform.media.agent-workload.v1\0")
    .update(lengthFrame(row.runRef))
    .update(lengthFrame(input.stableOutputSlotRef))
    .update(lengthFrame(input.agentMediaCommandRef))
    .digest("hex")}`;
  return Object.freeze({
    ownerBinding: Object.freeze({
      siteRef: row.siteRef,
      subjectRef: row.subjectRef,
      subjectGeneration,
      projectRef: row.projectRef,
      workloadRef,
      source: "agent_runtime" as const,
      definitionRevisionRef: row.definitionRevisionRef,
      modelOptionRevisionRef: row.modelOptionRevisionRef,
    }),
    budgetSource: Object.freeze({ kind: "agent_child" as const,
      executionBudgetRootRef: row.executionBudgetRootRef,
      authorizationSegmentRef: row.authorizationSegmentRef,
      executionManifestRef: row.executionManifestRef,
      parentAllocationRef: row.parentAllocationRef,
      expectedParentRevision,
      expectedParentAllocationEpoch, unit: row.creditUnit }),
    maximumCredit,
    trustInputDecisionRef: row.trustInputDecisionRef,
    consumptionScope: Object.freeze({ surfaceRef: row.creditSurfaceRef,
      capabilityKey: row.creditCapabilityKey, agentRef: row.creditAgentRef }),
    expiresAt,
    agentCommandAuthorization: authorization,
  });
}

function exactPositiveBigInt(value: bigint | string): bigint {
  if (typeof value !== "bigint" && !/^[1-9][0-9]*$/u.test(value)) {
    throw new Error("MEDIA_ACCESS_ROW_INVALID");
  }
  const parsed = BigInt(value);
  if (parsed < 1n || parsed > 99_999_999_999_999_999_999_999_999_999_999_999_999n) {
    throw new Error("MEDIA_ACCESS_ROW_INVALID");
  }
  return parsed;
}

function opaqueHandle(value: string): void {
  if (value.length < 32 || value.length > 8192 || value.trim() !== value || hasControlCharacter(value)) {
    throw new Error("MEDIA_OPAQUE_HANDLE_INVALID");
  }
}

function reference(value: string, maximum = 256): void {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum || value.trim() !== value ||
      hasControlCharacter(value)) throw new Error("MEDIA_ACCESS_ROW_INVALID");
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function lengthFrame(value: string): Buffer {
  const bytes = Buffer.from(value, "utf8");
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32BE(bytes.byteLength);
  return Buffer.concat([length, bytes]);
}

function instant(value: Date | string): string {
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error("MEDIA_ACCESS_ROW_INVALID");
  return parsed.toISOString();
}
