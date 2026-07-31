import { createHash } from "node:crypto";
import type { PlatformTransaction } from "../../../shared/unit-of-work/index.js";
import type { ImageEffectEvidenceFact } from "../domain/image-effect-evidence.js";
import { selectImageEffectEvidencePage } from "../domain/image-effect-evidence.js";
import type {
  ImageEffectAccessAuthorization,
  ImageEffectUnitOfWork,
  ImageEffectView,
} from "./image-effect-service.js";

export interface ImageEffectEvidenceRepository {
  readPage(transaction: PlatformTransaction, input: Readonly<{
    callerIdentity: string;
    logicalInvocationRef: string;
    afterEvidenceSequence: bigint;
    limit: number;
  }>): Promise<Readonly<{
    invocation: ImageEffectView;
    ownerHighWatermark: bigint;
    facts: readonly ImageEffectEvidenceFact[];
  }> | null>;
}

export type ImageEffectEvidencePage = Readonly<{
  invocation: ImageEffectView;
  evidenceFacts: readonly ImageEffectEvidenceFact[];
  nextEvidenceSequence: bigint;
  caughtUp: boolean;
}>;

export class ImageEffectEvidenceService {
  readonly #clock: () => Date;

  constructor(private readonly dependencies: Readonly<{
    unitOfWork: ImageEffectUnitOfWork;
    repository: ImageEffectEvidenceRepository;
    clock?: () => Date;
  }>) {
    this.#clock = dependencies.clock ?? (() => new Date());
  }

  async get(input: Readonly<{
    callerAccessHandle: string;
    logicalInvocationRef: string;
    afterEvidenceSequence: bigint;
    limit: number;
  }>): Promise<ImageEffectEvidencePage> {
    accessHandle(input.callerAccessHandle);
    reference(input.logicalInvocationRef);
    if (input.afterEvidenceSequence < 0n || !Number.isInteger(input.limit) ||
        input.limit < 1 || input.limit > 64) {
      throw new Error("IMAGE_EFFECT_EVIDENCE_CURSOR_INVALID");
    }
    return this.dependencies.unitOfWork.execute({ operation: "evidence",
      callerAccessHandle: input.callerAccessHandle }, async (transaction, authorization) => {
      this.#assertCaller(authorization, input.callerAccessHandle);
      const record = await this.dependencies.repository.readPage(transaction, {
        callerIdentity: authorization.callerIdentity,
        logicalInvocationRef: input.logicalInvocationRef,
        afterEvidenceSequence: input.afterEvidenceSequence,
        limit: input.limit,
      });
      if (record === null) throw new Error("IMAGE_EFFECT_COMMAND_NOT_FOUND");
      if (record.invocation.logicalInvocationRef !== input.logicalInvocationRef ||
          record.facts.length > input.limit || record.ownerHighWatermark < 0n ||
          record.facts.some((fact) => fact.logicalInvocationRef !== input.logicalInvocationRef ||
            fact.ownerVersion > record.invocation.ownerVersion)) {
        throw new Error("IMAGE_EFFECT_EVIDENCE_LEDGER_CORRUPT");
      }
      const page = selectImageEffectEvidencePage({ facts: record.facts,
        afterEvidenceSequence: input.afterEvidenceSequence, limit: input.limit,
        ownerHighWatermark: record.ownerHighWatermark });
      let expected = input.afterEvidenceSequence + 1n;
      for (const fact of page.facts) {
        if (fact.evidenceSequence !== expected) throw new Error("IMAGE_EFFECT_EVIDENCE_LEDGER_CORRUPT");
        expected += 1n;
      }
      if (page.facts.length === 0 && input.afterEvidenceSequence < record.ownerHighWatermark) {
        throw new Error("IMAGE_EFFECT_EVIDENCE_LEDGER_CORRUPT");
      }
      return Object.freeze({ invocation: record.invocation, evidenceFacts: page.facts,
        nextEvidenceSequence: page.nextEvidenceSequence, caughtUp: page.caughtUp });
    });
  }

  #assertCaller(authorization: ImageEffectAccessAuthorization, callerAccessHandle: string): void {
    const now = this.#clock();
    if (!Number.isFinite(now.getTime()) || authorization.callerAccessHandleDigest !== sha256(callerAccessHandle) ||
        authorization.callerAudience !== "platform-media-worker" ||
        authorization.authorizationGeneration < 1n || authorization.securityEpoch < 1n ||
        Date.parse(authorization.accessExpiresAt) <= now.getTime()) {
      throw new Error("IMAGE_EFFECT_ACCESS_DENIED");
    }
  }
}

function accessHandle(value: string): void {
  if (value.length < 32 || value.length > 8192 || /[\0\r\n]/u.test(value)) {
    throw new Error("IMAGE_EFFECT_ACCESS_HANDLE_INVALID");
  }
}

function reference(value: string): void {
  if (value.length < 1 || value.length > 256 || /[\0\r\n]/u.test(value)) {
    throw new Error("IMAGE_EFFECT_REFERENCE_INVALID");
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
