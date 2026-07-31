import { createHash, randomUUID } from "node:crypto";
import type { PlatformTransaction } from "../../../shared/unit-of-work/index.js";
import type {
  ImageEffectAccessAuthorization,
  ImageEffectCommandDigestAuthority,
  ImageEffectCommandReceiptRecord,
  ImageEffectUnitOfWork,
} from "./image-effect-service.js";

export type ImageEffectOutputEvidenceRecord = Readonly<{
  logicalInvocationRef: string;
  attemptRef: string;
  attemptOrdinal: number;
  outputEvidenceRef: string;
  outputEvidenceDigest: string;
  declaredByteSize?: bigint;
  providerOutputFactRef: string;
}>;

export type ImageEffectOutputAccessClaims = Readonly<{
  capabilityRef: string;
  siteId: string;
  callerIdentity: string;
  audience: "platform-media-worker";
  logicalInvocationRef: string;
  outputEvidenceRef: string;
  outputEvidenceDigest: string;
  maxReadableBytes: bigint;
  expiresAt: string;
  securityEpoch: bigint;
}>;

export type ImageEffectSealedRecoveryEnvelope = Readonly<{
  algorithm: string;
  keyRevision: string;
  nonce: string;
  ciphertext: string;
  authenticationTag: string;
}>;

export type ImageEffectOutputAccessRecord = Readonly<{
  siteId: string;
  callerIdentity: string;
  callerAccessHandleDigest: string;
  outputAccessCommandRef: string;
  requestDigest: string;
  receipt: ImageEffectCommandReceiptRecord & Readonly<{ kind: "output_access_issued" }>;
  claims: ImageEffectOutputAccessClaims;
  sourceAccessHandleDigest: string;
  recoveryEnvelope: ImageEffectSealedRecoveryEnvelope;
}>;

export interface ImageEffectOutputRepository {
  lockCommand(transaction: PlatformTransaction, input: Readonly<{
    callerIdentity: string;
    outputAccessCommandRef: string;
  }>): Promise<ImageEffectOutputAccessRecord | null>;
  lockEvidence(transaction: PlatformTransaction, input: Readonly<{
    callerIdentity: string;
    logicalInvocationRef: string;
    outputEvidenceRef: string;
  }>): Promise<ImageEffectOutputEvidenceRecord | null>;
  create(transaction: PlatformTransaction, record: ImageEffectOutputAccessRecord): Promise<void>;
  authorizeRead(input: Readonly<{
    sourceAccessHandleDigest: string;
    claims: ImageEffectOutputAccessClaims;
    now: string;
  }>): Promise<ImageEffectOutputEvidenceRecord | null>;
}

export interface ImageEffectOutputTokenAuthority {
  issue(claims: ImageEffectOutputAccessClaims): Readonly<{
    sourceAccessHandle: string;
    sourceAccessHandleDigest: string;
    recoveryEnvelope: ImageEffectSealedRecoveryEnvelope;
  }>;
  recover(envelope: ImageEffectSealedRecoveryEnvelope, claims: ImageEffectOutputAccessClaims): string;
  verify(sourceAccessHandle: string): ImageEffectOutputAccessClaims;
}

export interface ImageEffectOutputSourceReader {
  readRange(input: Readonly<{
    authorization: ImageEffectOutputEvidenceRecord;
    offset: bigint;
    maximumBytes: number;
    signal: AbortSignal;
  }>): AsyncIterable<Readonly<{ offset: bigint; data: Uint8Array; eof: boolean }>>;
}

export type ImageEffectOutputAccessResult = Readonly<{
  receipt: ImageEffectCommandReceiptRecord & Readonly<{ kind: "output_access_issued" }>;
  outputAccess: Readonly<{
    outputEvidenceRef: string;
    outputEvidenceDigest: string;
    sourceAccessHandle: string;
    sourceAccessExpiresAt: string;
    maxReadableBytes: bigint;
  }>;
  replayed: boolean;
}>;

export type ImageEffectOutputFrame = Readonly<{
  offset: bigint;
  data: Uint8Array;
  nextOffset: bigint;
  eof: boolean;
  chunkSha256: string;
}>;

export class ImageEffectOutputService {
  readonly #clock: () => Date;
  readonly #reference: () => string;
  readonly #capabilityTtlMs: number;
  readonly #maximumReadableBytes: bigint;

  constructor(private readonly dependencies: Readonly<{
    unitOfWork: ImageEffectUnitOfWork;
    repository: ImageEffectOutputRepository;
    commandDigest: ImageEffectCommandDigestAuthority;
    token: ImageEffectOutputTokenAuthority;
    objectReader: ImageEffectOutputSourceReader;
    clock?: () => Date;
    reference?: () => string;
    capabilityTtlMs?: number;
    maximumReadableBytes?: bigint;
  }>) {
    this.#clock = dependencies.clock ?? (() => new Date());
    this.#reference = dependencies.reference ?? (() => `image-output-capability:${randomUUID()}`);
    this.#capabilityTtlMs = dependencies.capabilityTtlMs ?? 120_000;
    this.#maximumReadableBytes = dependencies.maximumReadableBytes ?? 64n * 1024n * 1024n;
    if (!Number.isInteger(this.#capabilityTtlMs) || this.#capabilityTtlMs < 1_000 ||
        this.#capabilityTtlMs > 300_000 || this.#maximumReadableBytes < 1n) {
      throw new Error("IMAGE_EFFECT_OUTPUT_CAPABILITY_CONFIGURATION_INVALID");
    }
  }

  async issue(input: Readonly<{
    callerAccessHandle: string;
    outputAccessCommandRef: string;
    logicalInvocationRef: string;
    outputEvidenceRef: string;
    outputEvidenceDigest: string;
    callerRequestFingerprint: string;
  }>): Promise<ImageEffectOutputAccessResult> {
    accessHandle(input.callerAccessHandle);
    [input.outputAccessCommandRef, input.logicalInvocationRef, input.outputEvidenceRef].forEach(reference);
    [input.outputEvidenceDigest, input.callerRequestFingerprint].forEach(digest);
    return this.dependencies.unitOfWork.execute({ operation: "issue_output",
      callerAccessHandle: input.callerAccessHandle }, async (transaction, authorization) => {
      assertCaller(authorization, input.callerAccessHandle, this.#now());
      const requestDigest = this.dependencies.commandDigest.issueOutput({
        logicalInvocationRef: input.logicalInvocationRef,
        outputEvidenceRef: input.outputEvidenceRef,
        outputEvidenceDigest: input.outputEvidenceDigest,
      }, authorization);
      if (requestDigest !== input.callerRequestFingerprint) {
        throw new Error("IMAGE_EFFECT_CALLER_REQUEST_FINGERPRINT_MISMATCH");
      }
      const prior = await this.dependencies.repository.lockCommand(transaction, {
        callerIdentity: authorization.callerIdentity,
        outputAccessCommandRef: input.outputAccessCommandRef,
      });
      if (prior !== null) return this.#result(prior, true);
      const evidence = await this.dependencies.repository.lockEvidence(transaction, {
        callerIdentity: authorization.callerIdentity,
        logicalInvocationRef: input.logicalInvocationRef,
        outputEvidenceRef: input.outputEvidenceRef,
      });
      if (evidence === null || evidence.outputEvidenceDigest !== input.outputEvidenceDigest) {
        throw new Error("IMAGE_EFFECT_OUTPUT_EVIDENCE_NOT_FOUND");
      }
      const now = this.#now();
      const maximum = evidence.declaredByteSize === undefined
        ? this.#maximumReadableBytes
        : evidence.declaredByteSize < this.#maximumReadableBytes
          ? evidence.declaredByteSize
          : this.#maximumReadableBytes;
      const claims: ImageEffectOutputAccessClaims = Object.freeze({
        capabilityRef: validReference(this.#reference()),
        siteId: authorization.siteId,
        callerIdentity: authorization.callerIdentity,
        audience: "platform-media-worker",
        logicalInvocationRef: evidence.logicalInvocationRef,
        outputEvidenceRef: evidence.outputEvidenceRef,
        outputEvidenceDigest: evidence.outputEvidenceDigest,
        maxReadableBytes: maximum,
        expiresAt: new Date(now.getTime() + this.#capabilityTtlMs).toISOString(),
        securityEpoch: authorization.securityEpoch,
      });
      const issued = this.dependencies.token.issue(claims);
      accessHandle(issued.sourceAccessHandle);
      digest(issued.sourceAccessHandleDigest);
      const receiptCore = Object.freeze({
        callerCommandRef: input.outputAccessCommandRef,
        requestDigest,
        kind: "output_access_issued" as const,
        logicalInvocationRef: evidence.logicalInvocationRef,
        attemptRef: evidence.attemptRef,
        attemptOrdinal: evidence.attemptOrdinal,
        receiptVersion: 1n,
        recordedAt: now.toISOString(),
      });
      const identity = this.dependencies.commandDigest.receipt(receiptCore);
      const record: ImageEffectOutputAccessRecord = Object.freeze({
        siteId: authorization.siteId,
        callerIdentity: authorization.callerIdentity,
        callerAccessHandleDigest: authorization.callerAccessHandleDigest,
        outputAccessCommandRef: input.outputAccessCommandRef,
        requestDigest,
        receipt: Object.freeze({ ...receiptCore, ...identity }),
        claims,
        sourceAccessHandleDigest: issued.sourceAccessHandleDigest,
        recoveryEnvelope: issued.recoveryEnvelope,
      });
      await this.dependencies.repository.create(transaction, record);
      return this.#result(record, false, issued.sourceAccessHandle);
    });
  }

  async recover(input: Readonly<{
    callerAccessHandle: string;
    outputAccessCommandRef: string;
  }>): Promise<ImageEffectOutputAccessResult> {
    accessHandle(input.callerAccessHandle);
    reference(input.outputAccessCommandRef);
    return this.dependencies.unitOfWork.execute({ operation: "recover_output",
      callerAccessHandle: input.callerAccessHandle }, async (transaction, authorization) => {
      assertCaller(authorization, input.callerAccessHandle, this.#now());
      const record = await this.dependencies.repository.lockCommand(transaction, {
        callerIdentity: authorization.callerIdentity,
        outputAccessCommandRef: input.outputAccessCommandRef,
      });
      if (record === null) throw new Error("IMAGE_EFFECT_OUTPUT_ACCESS_COMMAND_NOT_FOUND");
      return this.#result(record, true);
    });
  }

  async *read(input: Readonly<{
    sourceAccessHandle: string;
    outputEvidenceRef: string;
    outputEvidenceDigest: string;
    offset: bigint;
    maxBytes: number;
    signal: AbortSignal;
  }>): AsyncIterable<ImageEffectOutputFrame> {
    accessHandle(input.sourceAccessHandle);
    reference(input.outputEvidenceRef);
    digest(input.outputEvidenceDigest);
    if (input.offset < 0n || !Number.isInteger(input.maxBytes) || input.maxBytes < 1 || input.maxBytes > 1_048_576) {
      throw new Error("IMAGE_EFFECT_OUTPUT_READ_LIMIT_INVALID");
    }
    const claims = this.dependencies.token.verify(input.sourceAccessHandle);
    const now = this.#now();
    if (claims.audience !== "platform-media-worker" || claims.outputEvidenceRef !== input.outputEvidenceRef ||
        claims.outputEvidenceDigest !== input.outputEvidenceDigest || Date.parse(claims.expiresAt) <= now.getTime() ||
        input.offset >= claims.maxReadableBytes) {
      throw new Error("IMAGE_EFFECT_OUTPUT_ACCESS_DENIED");
    }
    const remainingCapability = claims.maxReadableBytes - input.offset;
    const maximumBytes = Number(remainingCapability < BigInt(input.maxBytes)
      ? remainingCapability : BigInt(input.maxBytes));
    const authorization = await this.dependencies.repository.authorizeRead({
      sourceAccessHandleDigest: sha256(input.sourceAccessHandle), claims, now: now.toISOString(),
    });
    if (authorization === null || authorization.outputEvidenceRef !== input.outputEvidenceRef ||
        authorization.outputEvidenceDigest !== input.outputEvidenceDigest) {
      throw new Error("IMAGE_EFFECT_OUTPUT_ACCESS_DENIED");
    }
    let expectedOffset = input.offset;
    let emitted = 0;
    let eof = false;
    for await (const chunk of this.dependencies.objectReader.readRange({ authorization,
      offset: input.offset, maximumBytes, signal: input.signal })) {
      input.signal.throwIfAborted();
      const data = new Uint8Array(chunk.data);
      if (eof || data.byteLength < 1 || chunk.offset !== expectedOffset ||
          emitted + data.byteLength > maximumBytes) {
        throw new Error("IMAGE_EFFECT_OUTPUT_READER_PROTOCOL_INVALID");
      }
      const nextOffset = expectedOffset + BigInt(data.byteLength);
      eof = chunk.eof;
      emitted += data.byteLength;
      yield Object.freeze({ offset: expectedOffset, data, nextOffset, eof,
        chunkSha256: createHash("sha256").update(data).digest("hex") });
      expectedOffset = nextOffset;
    }
    if (!eof && emitted < maximumBytes) throw new Error("IMAGE_EFFECT_OUTPUT_READER_PROTOCOL_INVALID");
  }

  #result(
    record: ImageEffectOutputAccessRecord,
    replayed: boolean,
    issuedHandle?: string,
  ): ImageEffectOutputAccessResult {
    assertReceipt(record, this.dependencies.commandDigest);
    const sourceAccessHandle = issuedHandle ?? this.dependencies.token.recover(record.recoveryEnvelope, record.claims);
    if (sha256(sourceAccessHandle) !== record.sourceAccessHandleDigest) {
      throw new Error("IMAGE_EFFECT_OUTPUT_CAPABILITY_INTEGRITY_INVALID");
    }
    return Object.freeze({
      receipt: record.receipt,
      outputAccess: Object.freeze({
        outputEvidenceRef: record.claims.outputEvidenceRef,
        outputEvidenceDigest: record.claims.outputEvidenceDigest,
        sourceAccessHandle,
        sourceAccessExpiresAt: record.claims.expiresAt,
        maxReadableBytes: record.claims.maxReadableBytes,
      }),
      replayed,
    });
  }

  #now(): Date {
    const value = this.#clock();
    if (!Number.isFinite(value.getTime())) throw new Error("IMAGE_EFFECT_CLOCK_INVALID");
    return value;
  }
}

function assertReceipt(
  record: ImageEffectOutputAccessRecord,
  authority: Pick<ImageEffectCommandDigestAuthority, "receipt">,
): void {
  const receipt = record.receipt;
  const identity = authority.receipt({ callerCommandRef: receipt.callerCommandRef,
    requestDigest: receipt.requestDigest, kind: receipt.kind,
    logicalInvocationRef: receipt.logicalInvocationRef, attemptRef: receipt.attemptRef,
    attemptOrdinal: receipt.attemptOrdinal, receiptVersion: receipt.receiptVersion,
    recordedAt: receipt.recordedAt });
  if (receipt.callerCommandRef !== record.outputAccessCommandRef || receipt.requestDigest !== record.requestDigest ||
      identity.receiptRef !== receipt.receiptRef || identity.receiptDigest !== receipt.receiptDigest) {
    throw new Error("IMAGE_EFFECT_RECEIPT_INTEGRITY_INVALID");
  }
}

function assertCaller(authorization: ImageEffectAccessAuthorization, handle: string, now: Date): void {
  if (authorization.callerAccessHandleDigest !== sha256(handle) ||
      authorization.callerAudience !== "platform-media-worker" ||
      Date.parse(authorization.accessExpiresAt) <= now.getTime()) throw new Error("IMAGE_EFFECT_ACCESS_DENIED");
}
function accessHandle(value: string): void {
  if (Buffer.byteLength(value, "utf8") < 32 || Buffer.byteLength(value, "utf8") > 8192 || /[\0\r\n]/u.test(value)) {
    throw new Error("IMAGE_EFFECT_ACCESS_HANDLE_INVALID");
  }
}
function reference(value: string): void {
  if (value.length < 1 || value.length > 256 || /[\0\r\n]/u.test(value)) throw new Error("IMAGE_EFFECT_REFERENCE_INVALID");
}
function validReference(value: string): string { reference(value); return value; }
function digest(value: string): void {
  if (!/^[0-9a-f]{64}$/u.test(value)) throw new Error("IMAGE_EFFECT_DIGEST_INVALID");
}
function sha256(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }
