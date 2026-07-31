import { createHash, createHmac } from "node:crypto";

export type StoredAgentMediaCandidateView = Readonly<{
  candidateRef: string;
  ownerVersion: bigint;
  state: string;
  artifactVersionHandle?: string | undefined;
}>;

export type StoredAgentMediaOperationView = Readonly<{
  mediaOperationHandle: string;
  operationRef: string;
  ownerVersion: bigint;
  state: string;
  outcomeClass?: "canonical" | "irreconcilable" | undefined;
  observedAt: string;
  candidates: readonly StoredAgentMediaCandidateView[];
}>;

export type RecoveredAgentMediaCommand =
  | Readonly<{ kind: "not_found" }>
  | Readonly<{ kind: "processing"; callerRequestFingerprint: string; receipt: RecoveredMediaCommandReceipt }>
  | Readonly<{ kind: "committed"; callerRequestFingerprint: string; operationRef: string;
    receipt: RecoveredMediaCommandReceipt }>;

export type RecoveredMediaCommandReceipt = Readonly<{
  version: bigint;
  recordedAt: string;
  commandKind: "create_agent_image_operation";
  outcome: "submit_outcome_unknown" | "submit_accepted";
}>;

export interface MediaRuntimeQueryDatabase {
  recoverAgentMediaCommand(input: Readonly<{
    handleDigest: string;
    callerAudience: "ga.media-runtime";
    commandRef: string;
  }>): Promise<readonly Readonly<{
    commandState: "processing" | "committed";
    callerRequestFingerprint: string;
    operationRef: string | null;
    receiptVersion: bigint | string;
    receiptRecordedAt: Date | string;
    receiptKind: string;
    receiptOutcome: string;
  }>[]>;
  getAgentMediaOperation(input: Readonly<{
    handleDigest: string;
    operationRef: string;
  }>): Promise<readonly Readonly<{
    operationRef: string;
    ownerVersion: bigint | string;
    operationState: string;
    outcomeClass: string | null;
    observedAt: Date | string;
    candidates: unknown;
  }>[]>;
}

export class PostgresMediaRuntimeQueryRepository {
  readonly #key: Buffer;

  constructor(private readonly dependencies: Readonly<{
    database: MediaRuntimeQueryDatabase;
    handleKey: Uint8Array;
  }>) {
    if (dependencies.handleKey.byteLength !== 32) throw new Error("MEDIA_RUNTIME_HANDLE_KEY_INVALID");
    this.#key = Buffer.from(dependencies.handleKey);
  }

  async recoverByCommand(input: Readonly<{
    mediaAccessHandle: string;
    commandRef: string;
  }>): Promise<RecoveredAgentMediaCommand> {
    opaqueHandle(input.mediaAccessHandle);
    reference(input.commandRef);
    const rows = await this.dependencies.database.recoverAgentMediaCommand({
      handleDigest: digest(input.mediaAccessHandle),
      callerAudience: "ga.media-runtime",
      commandRef: input.commandRef,
    });
    if (rows.length === 0) return Object.freeze({ kind: "not_found" as const });
    if (rows.length !== 1) throw new Error("MEDIA_COMMAND_IDENTITY_AMBIGUOUS");
    const row = rows[0]!;
    fingerprint(row.callerRequestFingerprint);
    const receipt = recoveredReceipt(row);
    if (row.commandState === "processing" && row.operationRef === null) {
      if (receipt.outcome !== "submit_outcome_unknown") throw new Error("MEDIA_COMMAND_ROW_INVALID");
      return Object.freeze({ kind: "processing" as const,
        callerRequestFingerprint: row.callerRequestFingerprint, receipt });
    }
    if (row.commandState !== "committed" || row.operationRef === null) {
      throw new Error("MEDIA_COMMAND_ROW_INVALID");
    }
    if (receipt.outcome !== "submit_accepted") throw new Error("MEDIA_COMMAND_ROW_INVALID");
    reference(row.operationRef);
    return Object.freeze({ kind: "committed" as const,
      callerRequestFingerprint: row.callerRequestFingerprint, operationRef: row.operationRef, receipt });
  }

  async get(input: Readonly<{
    mediaAccessHandle: string;
    operationRef: string;
  }>): Promise<StoredAgentMediaOperationView | null> {
    opaqueHandle(input.mediaAccessHandle);
    reference(input.operationRef);
    const rows = await this.dependencies.database.getAgentMediaOperation({
      handleDigest: digest(input.mediaAccessHandle), operationRef: input.operationRef,
    });
    if (rows.length === 0) return null;
    if (rows.length !== 1) throw new Error("MEDIA_OPERATION_IDENTITY_AMBIGUOUS");
    const row = rows[0]!;
    if (row.operationRef !== input.operationRef) throw new Error("MEDIA_OPERATION_ROW_INVALID");
    const ownerVersion = positiveBigint(row.ownerVersion);
    const observedAt = instant(row.observedAt);
    const candidates = candidateRows(row.candidates).map((candidate) => Object.freeze({
      candidateRef: reference(candidate.candidateRef),
      ownerVersion: positiveBigint(candidate.ownerVersion),
      state: reference(candidate.state),
      ...(candidate.artifactVersionRef === null ? {} : {
        artifactVersionHandle: hmac(this.#key, "kokoro.platform.artifact-version-handle.v1\0",
          [input.mediaAccessHandle, candidate.artifactVersionRef]),
      }),
    }));
    return Object.freeze({
      mediaOperationHandle: hmac(this.#key, "kokoro.platform.media-operation-handle.v1\0",
        [input.mediaAccessHandle, row.operationRef]),
      operationRef: row.operationRef,
      ownerVersion,
      state: reference(row.operationState),
      ...(row.outcomeClass === null ? {} : { outcomeClass: outcomeClass(row.outcomeClass) }),
      observedAt,
      candidates: Object.freeze(candidates),
    });
  }
}

function recoveredReceipt(row: Readonly<{
  receiptVersion: bigint | string;
  receiptRecordedAt: Date | string;
  receiptKind: string;
  receiptOutcome: string;
}>): RecoveredMediaCommandReceipt {
  const version = positiveBigint(row.receiptVersion);
  const recordedAt = instant(row.receiptRecordedAt);
  if (row.receiptKind !== "create_agent_image_operation" ||
      (row.receiptOutcome !== "submit_outcome_unknown" && row.receiptOutcome !== "submit_accepted")) {
    throw new Error("MEDIA_COMMAND_ROW_INVALID");
  }
  return Object.freeze({ version, recordedAt, commandKind: row.receiptKind, outcome: row.receiptOutcome });
}

function outcomeClass(value: string): "canonical" | "irreconcilable" {
  if (value !== "canonical" && value !== "irreconcilable") throw new Error("MEDIA_OPERATION_ROW_INVALID");
  return value;
}

type CandidateRow = Readonly<{
  candidateRef: string;
  ownerVersion: bigint | string;
  state: string;
  artifactVersionRef: string | null;
}>;

function candidateRows(value: unknown): readonly CandidateRow[] {
  if (!Array.isArray(value) || value.length > 4) throw new Error("MEDIA_OPERATION_ROW_INVALID");
  return value.map((candidate) => {
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
      throw new Error("MEDIA_OPERATION_ROW_INVALID");
    }
    const row = candidate as Partial<CandidateRow>;
    if (typeof row.candidateRef !== "string" ||
        (typeof row.ownerVersion !== "string" && typeof row.ownerVersion !== "bigint") ||
        typeof row.state !== "string" ||
        (row.artifactVersionRef !== null && typeof row.artifactVersionRef !== "string")) {
      throw new Error("MEDIA_OPERATION_ROW_INVALID");
    }
    return Object.freeze({ candidateRef: row.candidateRef, ownerVersion: row.ownerVersion,
      state: row.state, artifactVersionRef: row.artifactVersionRef });
  });
}

function hmac(key: Buffer, domain: string, values: readonly string[]): string {
  const value = createHmac("sha256", key).update(domain);
  for (const item of values) value.update(frame(item));
  return `media_handle_v1.${value.digest("base64url")}`;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function fingerprint(value: string): void {
  if (!/^[0-9a-f]{64}$/u.test(value)) throw new Error("MEDIA_COMMAND_ROW_INVALID");
}

function positiveBigint(value: bigint | string): bigint {
  if (typeof value !== "bigint" && !/^[1-9][0-9]*$/u.test(value)) {
    throw new Error("MEDIA_OPERATION_ROW_INVALID");
  }
  const parsed = BigInt(value);
  if (parsed < 1n || parsed > 9_223_372_036_854_775_807n) throw new Error("MEDIA_OPERATION_ROW_INVALID");
  return parsed;
}

function instant(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("MEDIA_OPERATION_ROW_INVALID");
  return date.toISOString();
}

function opaqueHandle(value: string): void {
  if (value.length < 32 || value.length > 8192 || value.trim() !== value) {
    throw new Error("MEDIA_OPAQUE_HANDLE_INVALID");
  }
}

function reference(value: string): string {
  if (value.length < 1 || value.length > 256 || value.trim() !== value) {
    throw new Error("MEDIA_REFERENCE_INVALID");
  }
  return value;
}

function frame(value: string): Buffer {
  const bytes = Buffer.from(value);
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32BE(bytes.byteLength);
  return Buffer.concat([length, bytes]);
}
