import type {
  MediaOperationQuote,
  MediaOperationQuoteRequest,
} from "../../../../generated/contracts/openapi/platform-public/types.gen.js";
import type { PlatformTransaction } from
  "../../../../shared/unit-of-work/index.js";
import type { ResolvedMediaPublicOwnerAuthority } from "./media-public-read-ports.js";

export type MediaPublicQuoteJournalKey = Readonly<{
  authority: ResolvedMediaPublicOwnerAuthority;
  commandRef: string;
  idempotencyKey: string;
  requestDigest: string;
}>;

export type MediaPublicQuoteJournalBegin =
  | Readonly<{ kind: "started"; leaseRef: string }>
  | Readonly<{ kind: "replayed"; quote: MediaOperationQuote }>;

/**
 * A durable, owner-scoped idempotency journal. No production implementation exists until the
 * quote journal schema and its owner-only SECURITY DEFINER contract are migrated.
 */
export interface MediaPublicQuoteJournalPort {
  begin(
    transaction: PlatformTransaction,
    input: MediaPublicQuoteJournalKey & Readonly<{ now: string }>,
  ): Promise<MediaPublicQuoteJournalBegin>;
  commit(transaction: PlatformTransaction, input: MediaPublicQuoteJournalKey & Readonly<{
    leaseRef: string;
    quote: MediaOperationQuote;
    ratingPolicyRevisionRef: string;
    committedAt: string;
  }>): Promise<MediaOperationQuote>;
}

export type MediaPublicRatedQuote = Readonly<{
  amount: bigint;
  unit: string;
  definitionRevisionRef: string;
  modelOptionRevisionRef: string;
  ratingPolicyRevisionRef: string;
  expiresAt: string;
}>;

/** A rating owner; this is intentionally not maximum-credit metadata from a media definition. */
export interface MediaPublicQuotePricingPort {
  rate(transaction: PlatformTransaction, input: Readonly<{
    authority: ResolvedMediaPublicOwnerAuthority;
    operationInput: MediaOperationQuoteRequest;
    requestDigest: string;
    now: string;
  }>): Promise<MediaPublicRatedQuote>;
}
