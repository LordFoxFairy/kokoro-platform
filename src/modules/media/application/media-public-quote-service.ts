import { createHmac, timingSafeEqual } from "node:crypto";
import type { PlatformPublicOperationExecution } from
  "../../../interfaces/http/platform-public-operation-registry.js";
import { canonicalMediaOperationInputV1Bytes } from
  "../../../generated/contracts/openapi/platform-public/media-canonical.js";
import type { MediaOperationQuote, MediaOperationQuoteResponse } from
  "../../../generated/contracts/openapi/platform-public/types.gen.js";
import { zMediaOperationQuote } from "../../../generated/contracts/openapi/platform-public/zod.gen.js";
import type {
  MediaPublicQuoteJournalPort,
  MediaPublicQuoteJournalBegin,
  MediaPublicQuotePricingPort,
  MediaPublicRatedQuote,
} from "./contracts/media-public-quote-ports.js";
import type {
  MediaPublicReadRepository,
  MediaPublicUnitOfWork,
  ResolvedMediaPublicOwnerAuthority,
} from "./contracts/media-public-read-ports.js";
import { mediaPublicOwnerAssertion } from "./media-public-read-owner.js";

const DIGEST_DOMAIN = "kokoro.media.public-quote-command.v1\0";

export class MediaPublicQuoteService {
  readonly #clock: () => Date;
  readonly #digestKey: Buffer;

  constructor(private readonly dependencies: Readonly<{
    unitOfWork: MediaPublicUnitOfWork;
    readRepository: Pick<MediaPublicReadRepository, "resolveOwnerAuthority">;
    journal: MediaPublicQuoteJournalPort;
    pricing: MediaPublicQuotePricingPort;
    commandDigestKey: Uint8Array;
    reference: (input: Readonly<{
      authority: ResolvedMediaPublicOwnerAuthority;
      commandRef: string;
      requestDigest: string;
    }>) => string;
    clock?: () => Date;
  }>) {
    if (dependencies.commandDigestKey.byteLength !== 32) {
      throw new Error("MEDIA_PUBLIC_QUOTE_DIGEST_KEY_INVALID");
    }
    this.#digestKey = Buffer.from(dependencies.commandDigestKey);
    this.#clock = dependencies.clock ?? (() => new Date());
  }

  async quoteMediaOperation(
    input: PlatformPublicOperationExecution<"quoteMediaOperation">,
  ): Promise<MediaOperationQuoteResponse> {
    abort(input.signal);
    const assertion = mediaPublicOwnerAssertion(input);
    const now = instant(this.#clock(), "MEDIA_PUBLIC_QUOTE_CLOCK_INVALID");
    return this.dependencies.unitOfWork.execute({ context: input.context, operation: input.operationId },
      async (transaction) => {
        const authority = await this.dependencies.readRepository.resolveOwnerAuthority(transaction, {
          assertion, now,
        });
        if (authority === null) throw new Error("MEDIA_PUBLIC_NOT_AVAILABLE");
        const commandRef = reference(input.headers["X-Kokoro-Command-Id"]);
        const idempotencyKey = idempotency(input.headers["Idempotency-Key"]);
        const requestDigest = digest(this.#digestKey, input, authority);
        const key = Object.freeze({ authority, commandRef, idempotencyKey, requestDigest });
        const started = journalBegin(await this.dependencies.journal.begin(transaction, { ...key, now }));
        if (started.kind === "replayed") {
          abort(input.signal);
          return Object.freeze({ quote: quote(started.quote) });
        }
        if (started.kind !== "started") throw new Error("MEDIA_PUBLIC_QUOTE_JOURNAL_CORRUPT");
        const leaseRef = reference(started.leaseRef);
        const rated = ratedQuote(await this.dependencies.pricing.rate(transaction, {
          authority, operationInput: input.body, requestDigest, now,
        }), input.body, now);
        const value = quote(Object.freeze({
          quoteRef: quoteReference(this.dependencies.reference({ authority, commandRef, requestDigest })),
          nonBinding: true,
          definitionRevisionRef: rated.definitionRevisionRef,
          modelOptionRevisionRef: rated.modelOptionRevisionRef,
          estimate: Object.freeze({ amount: rated.amount.toString(), creditUnit: rated.unit }),
          expiresAt: rated.expiresAt,
        }));
        const committed = quote(await this.dependencies.journal.commit(transaction, {
          ...key, leaseRef, quote: value,
          ratingPolicyRevisionRef: rated.ratingPolicyRevisionRef, committedAt: now,
        }));
        if (!sameQuote(committed, value)) throw new Error("MEDIA_PUBLIC_QUOTE_JOURNAL_CORRUPT");
        abort(input.signal);
        return Object.freeze({ quote: committed });
      });
  }
}

function digest(
  key: Buffer,
  input: PlatformPublicOperationExecution<"quoteMediaOperation">,
  authority: ResolvedMediaPublicOwnerAuthority,
): string {
  const canonical = canonicalMediaOperationInputV1Bytes({ contractMajor: 1, ...input.body });
  const hmac = createHmac("sha256", key).update(DIGEST_DOMAIN, "utf8").update(frame(canonical));
  for (const value of [authority.siteRef, authority.siteReleaseRef, authority.siteProjectBindingRef,
    authority.deploymentRef, authority.workloadIdentityRef,
    authority.workloadBindingEpoch.toString(), authority.siteSecurityEpoch.toString(),
    authority.policyEpoch.toString(), authority.environment, authority.region, authority.audience,
    authority.subjectRef, authority.subjectGeneration.toString(),
    authority.identitySessionRef, authority.identitySessionEpoch.toString(),
    authority.restrictionEpoch.toString(), authority.credentialEpoch.toString(), authority.projectRef,
    authority.membershipEpoch.toString(), authority.authorizationEpoch.toString(),
    authority.modelOptionCatalogRef, input.headers["X-Kokoro-Command-Id"],
    input.headers["Idempotency-Key"]]) hmac.update(frame(Buffer.from(value, "utf8")));
  return hmac.digest("hex");
}

function ratedQuote(value: MediaPublicRatedQuote,
  requested: PlatformPublicOperationExecution<"quoteMediaOperation">["body"], now: string): MediaPublicRatedQuote {
  if (typeof value !== "object" || value === null ||
      Object.keys(value).sort().join(",") !==
        "amount,definitionRevisionRef,expiresAt,modelOptionRevisionRef,ratingPolicyRevisionRef,unit" ||
      typeof value.amount !== "bigint" || value.amount < 0n ||
      !boundedText(value.unit, 1, 64) || !boundedText(value.ratingPolicyRevisionRef, 1, 256) ||
      value.definitionRevisionRef !== requested.definitionRevisionRef ||
      value.modelOptionRevisionRef !== requested.modelOptionRevisionRef ||
      canonicalInstant(value.expiresAt) <= now) throw new Error("MEDIA_PUBLIC_QUOTE_RATING_CORRUPT");
  return Object.freeze({ ...value, expiresAt: canonicalInstant(value.expiresAt) });
}

function journalBegin(value: MediaPublicQuoteJournalBegin): MediaPublicQuoteJournalBegin {
  if (typeof value !== "object" || value === null) throw new Error("MEDIA_PUBLIC_QUOTE_JOURNAL_CORRUPT");
  if (value.kind === "started" && Object.keys(value).sort().join(",") === "kind,leaseRef" &&
      boundedText(value.leaseRef, 1, 256)) return Object.freeze({ ...value });
  if (value.kind === "replayed" && Object.keys(value).sort().join(",") === "kind,quote") {
    return Object.freeze({ kind: value.kind, quote: quote(value.quote) });
  }
  throw new Error("MEDIA_PUBLIC_QUOTE_JOURNAL_CORRUPT");
}

function quote(value: unknown): MediaOperationQuote {
  try {
    const parsed = zMediaOperationQuote.parse(value);
    return Object.freeze({ ...parsed, estimate: Object.freeze({ ...parsed.estimate }) });
  }
  catch { throw new Error("MEDIA_PUBLIC_QUOTE_JOURNAL_CORRUPT"); }
}
function sameQuote(left: MediaOperationQuote, right: MediaOperationQuote): boolean {
  const leftBytes = Buffer.from(JSON.stringify(left));
  const rightBytes = Buffer.from(JSON.stringify(right));
  return leftBytes.byteLength === rightBytes.byteLength && timingSafeEqual(leftBytes, rightBytes);
}
function frame(value: Uint8Array): Buffer {
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32BE(value.byteLength);
  return Buffer.concat([length, value]);
}
function abort(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
}
function instant(value: Date, code: string): string {
  if (!Number.isFinite(value.getTime())) throw new Error(code);
  return value.toISOString();
}
function canonicalInstant(value: string): string {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error("MEDIA_PUBLIC_QUOTE_RATING_CORRUPT");
  return parsed.toISOString();
}
function reference(value: string): string {
  if (!boundedText(value, 1, 256) || /[\0\r\n]/u.test(value)) {
    throw new Error("MEDIA_PUBLIC_QUOTE_JOURNAL_CORRUPT");
  }
  return value;
}
function quoteReference(value: string): string {
  if (!boundedText(value, 3, 128)) throw new Error("MEDIA_PUBLIC_QUOTE_REFERENCE_INVALID");
  return value;
}
function idempotency(value: string): string {
  if (!boundedText(value, 16, 191)) throw new Error("INVALID_REQUEST");
  return value;
}
function boundedText(value: unknown, minimum: number, maximum: number): value is string {
  return typeof value === "string" && value.length >= minimum && value.length <= maximum &&
    value.trim() === value && !/[\0\r\n]/u.test(value);
}
