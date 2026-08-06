import type { ImageAspectRatio, ImageOutputFormat } from
  "../../../../generated/contracts/openapi/platform-public/types.gen.js";
import type { PlatformTransaction } from
  "../../../../shared/unit-of-work/index.js";
import type { VerifiedRequestSecurityContext } from
  "../../../../shared/security-context/index.js";

export type MediaPublicOwnerAuthorityAssertion = Readonly<{
  siteRef: string;
  siteReleaseRef: string;
  siteProjectBindingRef: string;
  deploymentRef: string;
  workloadIdentityRef: string;
  workloadBindingEpoch: bigint;
  siteSecurityEpoch: bigint;
  policyEpoch: bigint;
  environment: string;
  region: string;
  audience: string;
  subjectRef: string;
  subjectGeneration: bigint;
  identitySessionRef: string;
  identitySessionEpoch: bigint;
  restrictionEpoch: bigint;
  credentialEpoch: bigint;
  projectRef: string;
}>;

export type ResolvedMediaPublicOwnerAuthority = MediaPublicOwnerAuthorityAssertion & Readonly<{
  membershipEpoch: bigint;
  authorizationEpoch: bigint;
  modelOptionCatalogRef: string;
}>;

export type MediaPublicDefinitionRecord = Readonly<{
  definitionKey: "image.text_to_image@v1";
  definitionRevisionRef: string;
  mediaKind: "image_text_to_image";
  maximumCandidateCount: number;
  promptMaximumUtf8Bytes: 32768;
  supportedAspectRatios: readonly ImageAspectRatio[];
  supportedOutputFormats: readonly ImageOutputFormat[];
  publishedAt: string;
  modelOptionCatalogRevisionRef: string;
}>;

export type MediaPublicModelOptionRecord = Readonly<{
  position: number;
  definitionRevisionRef: string;
  modelOptionRevisionRef: string;
  optionKey: string;
  label: string;
  description: string | null;
  inputModalities: readonly string[];
  outputModalities: readonly string[];
  supportedEfforts: readonly string[];
  badges: readonly string[];
  availability: "available" | "temporarily_unavailable";
}>;

export type MediaPublicCandidateRecord = Readonly<{
  candidateRef: string;
  ordinal: number;
  ownerVersion: bigint;
  state: "allocated" | "producing" | "output_received" | "validating" | "ready" |
    "restricted" | "failed" | "unknown" | "cancel_requested" | "canceled";
  artifactRef: string;
  artifactVersionRef: string;
}>;

export type MediaPublicOperationRecord = Readonly<{
  operationRef: string;
  definitionKey: "image.text_to_image@v1";
  definitionRevisionRef: string;
  modelOptionRevisionRef: string;
  state: "admission_pending" | "authorized" | "queued" | "active" | "finalizing" |
    "cancel_requested" | "reconciling" | "completed" | "partial" | "failed" | "canceled";
  outcomeClass: "canonical" | "irreconcilable" | null;
  ownerVersion: bigint;
  terminalFailure: unknown | null;
  financialReceiptRef: string | null;
  actualCost: bigint | null;
  terminalCreditUnit: string | null;
  createdAt: string;
  updatedAt: string;
  candidates: readonly MediaPublicCandidateRecord[];
}>;

export interface MediaPublicReadRepository {
  resolveOwnerAuthority(
    transaction: PlatformTransaction,
    input: Readonly<{ assertion: MediaPublicOwnerAuthorityAssertion; now: string }>,
  ): Promise<ResolvedMediaPublicOwnerAuthority | null>;
  listDefinitions(transaction: PlatformTransaction, input: Readonly<{
    authority: ResolvedMediaPublicOwnerAuthority;
    publishedBefore: string | null;
    definitionRevisionRefBefore: string | null;
    limit: number;
  }>): Promise<readonly MediaPublicDefinitionRecord[]>;
  getDefinition(transaction: PlatformTransaction, input: Readonly<{
    authority: ResolvedMediaPublicOwnerAuthority;
    definitionRef: string;
  }>): Promise<MediaPublicDefinitionRecord | null>;
  listModelOptions(transaction: PlatformTransaction, input: Readonly<{
    authority: ResolvedMediaPublicOwnerAuthority;
    definitionRef: string;
    positionAfter: number | null;
    modelOptionRevisionRefAfter: string | null;
    limit: number;
  }>): Promise<Readonly<{
    definitionRevisionRef: string;
    options: readonly MediaPublicModelOptionRecord[];
  }> | null>;
  listOperations(transaction: PlatformTransaction, input: Readonly<{
    authority: ResolvedMediaPublicOwnerAuthority;
    createdBefore: string | null;
    operationRefBefore: string | null;
    limit: number;
  }>): Promise<readonly MediaPublicOperationRecord[]>;
  getOperation(transaction: PlatformTransaction, input: Readonly<{
    authority: ResolvedMediaPublicOwnerAuthority;
    operationRef: string;
  }>): Promise<MediaPublicOperationRecord | null>;
}

export interface MediaPublicUnitOfWork {
  execute<Result>(
    fence: Readonly<{ context: VerifiedRequestSecurityContext; operation: string }>,
    work: (transaction: PlatformTransaction) => Promise<Result>,
  ): Promise<Result>;
}

export type MediaPublicCursorInput =
  | Readonly<{ kind: "definition"; owner: ResolvedMediaPublicOwnerAuthority;
      publishedAt: string; ref: string }>
  | Readonly<{ kind: "operation"; owner: ResolvedMediaPublicOwnerAuthority;
      createdAt: string; ref: string }>
  | Readonly<{ kind: "model_option"; owner: ResolvedMediaPublicOwnerAuthority;
      definitionRef: string; position: number; ref: string }>;

export type MediaPublicCursorExpectation =
  | Readonly<{ kind: "definition" | "operation"; owner: ResolvedMediaPublicOwnerAuthority }>
  | Readonly<{ kind: "model_option"; owner: ResolvedMediaPublicOwnerAuthority; definitionRef: string }>;

export type DecodedMediaPublicCursor =
  | Readonly<{ kind: "definition"; publishedAt: string; ref: string }>
  | Readonly<{ kind: "operation"; createdAt: string; ref: string }>
  | Readonly<{ kind: "model_option"; position: number; ref: string }>;

export interface MediaPublicCursorCodec {
  encode(input: MediaPublicCursorInput): string;
  decode(value: string, expected: MediaPublicCursorExpectation): DecodedMediaPublicCursor;
}
