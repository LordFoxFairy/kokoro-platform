import { createHash } from "node:crypto";
import {
  runRequestSchema,
  type ExecutionContextIntent,
  type RunRequest,
} from "@kokoro/platform-kit";
import { z } from "zod";

export const MAX_GA_RUN_REQUEST_DRAFT_TTL_MS = 5 * 60 * 1_000;
// Leaves 256 KiB inside the 1 MiB encrypted-envelope budget for AEAD/HPKE and framing overhead.
export const MAX_GA_RUN_REQUEST_PLAINTEXT_BYTES = 768 * 1024;
const MAX_GA_RUN_REQUEST_CIPHERTEXT_BYTES = 1024 * 1024;
export const GA_RUN_REQUEST_ENCRYPTION_ALGORITHM = "HPKE-v1";

/** Platform-resolved facts. This boundary does not derive identity, policy, budget, or capabilities. */
export type VerifiedGaRunRequestOwnerFacts = Omit<RunRequest, "execution_context">;

/** Audience-bound encrypted material; callers must not expose or log it. */
export const sealedGaRunRequestDraftSchema = z
  .object({
    ciphertext: z
      .instanceof(Uint8Array)
      .refine(
        (value) =>
          value.byteLength >= 32 && value.byteLength <= MAX_GA_RUN_REQUEST_CIPHERTEXT_BYTES,
      ),
    encryptionAlgorithm: boundedTrimmedString(64),
    keyRevisionRef: boundedTrimmedString(128),
    audience: boundedTrimmedString(128),
    expiresAt: z.string().refine(isCanonicalInstant),
    plaintextSha256: z.string().regex(/^[0-9a-f]{64}$/u),
  })
  .strict();
export type SealedGaRunRequestDraft = z.infer<typeof sealedGaRunRequestDraftSchema>;

/** The factory owns these exact bytes and digest; the sealer only encrypts them. */
export interface GaRunRequestDraftSealInput {
  readonly plaintext: Uint8Array;
  readonly plaintextSha256: string;
  readonly audience: string;
  readonly maximumExpiresAt: string;
}

/** Sealer output is deliberately untrusted until the factory validates it. */
export interface GaRunRequestDraftSealer {
  seal(input: GaRunRequestDraftSealInput): Promise<unknown>;
}

export class GaRunRequestDraftFactory {
  readonly #sealer: GaRunRequestDraftSealer;
  readonly #expectedAudience: string;
  readonly #clock: () => Date;

  constructor(
    input: Readonly<{
      sealer: GaRunRequestDraftSealer;
      expectedAudience: string;
      clock?: () => Date;
    }>,
  ) {
    if (input.sealer === null || typeof input.sealer?.seal !== "function") {
      throw new Error("ADMISSION_GA_DRAFT_SEALER_REQUIRED");
    }
    const audience = boundedTrimmedString(128).safeParse(input.expectedAudience);
    if (!audience.success) throw new Error("ADMISSION_GA_DRAFT_AUDIENCE_INVALID");
    this.#sealer = input.sealer;
    this.#expectedAudience = audience.data;
    this.#clock = input.clock ?? (() => new Date());
  }

  async create(
    input: Readonly<{
      ownerFacts: VerifiedGaRunRequestOwnerFacts;
      executionContext: ExecutionContextIntent;
    }>,
  ): Promise<SealedGaRunRequestDraft> {
    const request = runRequestSchema.parse({
      ...input.ownerFacts,
      execution_context: input.executionContext,
    });
    const plaintext = encodeCanonicalRequest(request);
    if (plaintext.byteLength > MAX_GA_RUN_REQUEST_PLAINTEXT_BYTES) {
      throw new Error("ADMISSION_GA_DRAFT_PLAINTEXT_TOO_LARGE");
    }
    const plaintextSha256 = createHash("sha256").update(plaintext).digest("hex");
    const startedAt = this.#now();
    const maximumExpiresAt = new Date(startedAt + MAX_GA_RUN_REQUEST_DRAFT_TTL_MS).toISOString();
    const sealerPlaintext = new Uint8Array(plaintext);
    const untrusted = await this.#sealer.seal(
      Object.freeze({
        plaintext: sealerPlaintext,
        plaintextSha256,
        audience: this.#expectedAudience,
        maximumExpiresAt,
      }),
    );
    if (createHash("sha256").update(sealerPlaintext).digest("hex") !== plaintextSha256) {
      throw new Error("ADMISSION_GA_DRAFT_PLAINTEXT_MUTATED");
    }
    const parsed = sealedGaRunRequestDraftSchema.safeParse(untrusted);
    if (!parsed.success) throw new Error("ADMISSION_GA_DRAFT_SEALED_MATERIAL_INVALID");
    const expiresAt = Date.parse(parsed.data.expiresAt);
    if (
      parsed.data.audience !== this.#expectedAudience ||
      parsed.data.encryptionAlgorithm !== GA_RUN_REQUEST_ENCRYPTION_ALGORITHM ||
      parsed.data.plaintextSha256 !== plaintextSha256 ||
      expiresAt <= this.#now() ||
      expiresAt > Date.parse(maximumExpiresAt)
    ) {
      throw new Error("ADMISSION_GA_DRAFT_SEALED_MATERIAL_INVALID");
    }
    return Object.freeze({
      ...parsed.data,
      ciphertext: new Uint8Array(parsed.data.ciphertext),
    });
  }

  #now(): number {
    const value = this.#clock().getTime();
    if (!Number.isFinite(value)) throw new Error("ADMISSION_GA_DRAFT_CLOCK_INVALID");
    return value;
  }
}

function boundedTrimmedString(maximumLength: number) {
  return z
    .string()
    .min(1)
    .max(maximumLength)
    .refine((value) => value.trim() === value);
}

function isCanonicalInstant(value: string): boolean {
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function encodeCanonicalRequest(request: RunRequest): Uint8Array {
  try {
    return new TextEncoder().encode(canonicalJson(request, new Set<object>()));
  } catch (cause) {
    throw new Error("ADMISSION_GA_DRAFT_PLAINTEXT_INVALID", { cause });
  }
}

function canonicalJson(value: unknown, ancestors: Set<object>): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
    case "string":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) throw new Error("non-finite number");
      return JSON.stringify(value);
    case "object": {
      if (ancestors.has(value)) throw new Error("cyclic object");
      ancestors.add(value);
      try {
        if (Array.isArray(value)) {
          const items: string[] = [];
          for (let index = 0; index < value.length; index += 1) {
            if (!(index in value)) throw new Error("sparse array");
            items.push(canonicalJson(value[index], ancestors));
          }
          return `[${items.join(",")}]`;
        }
        const prototype = Object.getPrototypeOf(value);
        if (prototype !== Object.prototype && prototype !== null)
          throw new Error("non-JSON object");
        const object = value as Record<string, unknown>;
        const keys = Object.keys(object);
        if (Reflect.ownKeys(object).length !== keys.length) throw new Error("non-JSON property");
        return `{${keys
          .sort()
          .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key], ancestors)}`)
          .join(",")}}`;
      } finally {
        ancestors.delete(value);
      }
    }
    default:
      throw new Error("non-JSON value");
  }
}
