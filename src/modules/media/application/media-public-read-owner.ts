import type { PlatformPublicOperationExecution } from
  "../../../interfaces/http/platform-public-operation-registry.js";
import type {
  ImageTextToImageOperationDefinition,
  MediaCandidateView,
  MediaDefinitionModelOptionPage,
  MediaOperationDefinitionPage,
  MediaOperationDefinitionResponse,
  MediaOperationPage,
  MediaOperationResponse,
  MediaOperationView,
  MediaSafeFailure,
  PublishedModelOption,
} from "../../../generated/contracts/openapi/platform-public/types.gen.js";
import type { PlatformTransaction } from "../../../shared/unit-of-work/index.js";
import type {
  MediaPublicCursorCodec,
  MediaPublicCandidateRecord,
  MediaPublicDefinitionRecord,
  MediaPublicModelOptionRecord,
  MediaPublicOperationRecord,
  MediaPublicOwnerAuthorityAssertion,
  MediaPublicReadRepository,
  MediaPublicUnitOfWork,
  ResolvedMediaPublicOwnerAuthority,
} from "./contracts/media-public-read-ports.js";

const DEFAULT_LIMIT = 50;
const MAXIMUM_LIMIT = 100;

export class MediaPublicReadOwner {
  readonly #clock: () => Date;
  constructor(private readonly dependencies: Readonly<{
    unitOfWork: MediaPublicUnitOfWork;
    repository: MediaPublicReadRepository;
    cursors: MediaPublicCursorCodec;
    clock?: () => Date;
  }>) {
    this.#clock = dependencies.clock ?? (() => new Date());
  }

  async listMediaOperationDefinitions(
    input: PlatformPublicOperationExecution<"listMediaOperationDefinitions">,
  ): Promise<MediaOperationDefinitionPage> {
    const limit = boundedLimit(input.query.limit);
    return this.#withAuthority(input, async (transaction, authority) => {
      const cursor = input.query.cursor === undefined ? null :
        this.dependencies.cursors.decode(input.query.cursor, { kind: "definition", owner: authority });
      if (cursor !== null && cursor.kind !== "definition") throw new Error("MEDIA_PAGE_CURSOR_INVALID");
      const rows = await this.dependencies.repository.listDefinitions(transaction, {
        authority, publishedBefore: cursor?.publishedAt ?? null,
        definitionRevisionRefBefore: cursor?.ref ?? null, limit: limit + 1,
      });
      const hasMore = rows.length > limit;
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      return Object.freeze({ items: page.map(definitionView), pageInfo: Object.freeze({ hasMore,
        nextCursor: hasMore && last !== undefined ? this.dependencies.cursors.encode({
          kind: "definition", owner: authority, publishedAt: last.publishedAt,
          ref: last.definitionRevisionRef,
        }) : null }) });
    });
  }

  async getMediaOperationDefinition(
    input: PlatformPublicOperationExecution<"getMediaOperationDefinition">,
  ): Promise<MediaOperationDefinitionResponse> {
    return this.#withAuthority(input, async (transaction, authority) => {
      const row = await this.dependencies.repository.getDefinition(transaction, {
        authority, definitionRef: reference(input.path.definitionRef),
      });
      if (row === null) throw new Error("MEDIA_PUBLIC_NOT_AVAILABLE");
      return Object.freeze({ definition: definitionView(row) });
    });
  }

  async listMediaOperationModelOptions(
    input: PlatformPublicOperationExecution<"listMediaOperationModelOptions">,
  ): Promise<MediaDefinitionModelOptionPage> {
    const definitionRef = reference(input.path.definitionRef);
    const limit = boundedLimit(input.query.limit);
    return this.#withAuthority(input, async (transaction, authority) => {
      const cursor = input.query.cursor === undefined ? null : this.dependencies.cursors.decode(
        input.query.cursor, { kind: "model_option", owner: authority, definitionRef },
      );
      if (cursor !== null && cursor.kind !== "model_option") throw new Error("MEDIA_PAGE_CURSOR_INVALID");
      const page = await this.dependencies.repository.listModelOptions(transaction, {
        authority, definitionRef, positionAfter: cursor?.position ?? null,
        modelOptionRevisionRefAfter: cursor?.ref ?? null, limit: limit + 1,
      });
      if (page === null) throw new Error("MEDIA_PUBLIC_NOT_AVAILABLE");
      const hasMore = page.options.length > limit;
      const rows = page.options.slice(0, limit);
      const last = rows.at(-1);
      return Object.freeze({ definitionRevisionRef: page.definitionRevisionRef,
        items: rows.map(modelOptionView), pageInfo: Object.freeze({ hasMore,
          nextCursor: hasMore && last !== undefined ? this.dependencies.cursors.encode({
            kind: "model_option", owner: authority, definitionRef,
            position: last.position, ref: last.modelOptionRevisionRef,
          }) : null }) });
    });
  }

  async listMediaOperations(
    input: PlatformPublicOperationExecution<"listMediaOperations">,
  ): Promise<MediaOperationPage> {
    const limit = boundedLimit(input.query.limit);
    return this.#withAuthority(input, async (transaction, authority) => {
      const cursor = input.query.cursor === undefined ? null :
        this.dependencies.cursors.decode(input.query.cursor, { kind: "operation", owner: authority });
      if (cursor !== null && cursor.kind !== "operation") throw new Error("MEDIA_PAGE_CURSOR_INVALID");
      const records = await this.dependencies.repository.listOperations(transaction, {
        authority, createdBefore: cursor?.createdAt ?? null,
        operationRefBefore: cursor?.ref ?? null, limit: limit + 1,
      });
      const hasMore = records.length > limit;
      const page = records.slice(0, limit);
      const last = page.at(-1);
      return Object.freeze({ items: page.map(operationView), pageInfo: Object.freeze({ hasMore,
        nextCursor: hasMore && last !== undefined ? this.dependencies.cursors.encode({
          kind: "operation", owner: authority, createdAt: last.createdAt, ref: last.operationRef,
        }) : null }) });
    });
  }

  async getMediaOperation(
    input: PlatformPublicOperationExecution<"getMediaOperation">,
  ): Promise<MediaOperationResponse> {
    return this.#withAuthority(input, async (transaction, authority) => {
      const record = await this.dependencies.repository.getOperation(transaction, {
        authority, operationRef: reference(input.path.operationRef),
      });
      if (record === null) throw new Error("MEDIA_PUBLIC_NOT_AVAILABLE");
      return Object.freeze({ operation: operationView(record) });
    });
  }

  async #withAuthority<Id extends ReadOperationId, Result>(
    input: PlatformPublicOperationExecution<Id>,
    work: (transaction: PlatformTransaction, authority: ResolvedMediaPublicOwnerAuthority) => Promise<Result>,
  ): Promise<Result> {
    if (input.signal.aborted) throw input.signal.reason ?? new DOMException("Aborted", "AbortError");
    const assertion = mediaPublicOwnerAssertion(input);
    const now = this.#instant();
    return this.dependencies.unitOfWork.execute({ context: input.context, operation: input.operationId },
      async (transaction) => {
        const authority = await this.dependencies.repository.resolveOwnerAuthority(transaction, { assertion, now });
        if (authority === null) throw new Error("MEDIA_PUBLIC_NOT_AVAILABLE");
        const result = await work(transaction, authority);
        if (input.signal.aborted) throw input.signal.reason ?? new DOMException("Aborted", "AbortError");
        return result;
      });
  }

  #instant(): string {
    const value = this.#clock();
    if (!Number.isFinite(value.getTime())) throw new Error("MEDIA_PUBLIC_CLOCK_INVALID");
    return value.toISOString();
  }
}

type ReadOperationId = "listMediaOperationDefinitions" | "getMediaOperationDefinition" |
  "listMediaOperationModelOptions" | "listMediaOperations" | "getMediaOperation";

export type MediaPublicOwnerOperationId = ReadOperationId | "quoteMediaOperation";

export function mediaPublicOwnerAssertion<Id extends MediaPublicOwnerOperationId>(
  input: PlatformPublicOperationExecution<Id>,
): MediaPublicOwnerAuthorityAssertion {
  const { context, session, workload } = input;
  const projectRef = "projectRef" in input.path ? input.path.projectRef : null;
  if (session === null || context.actor.kind !== "user" || projectRef === null ||
      context.target.siteId !== workload.siteRef || context.target.projectId !== projectRef ||
      context.actor.subjectId !== session.subjectRef || context.actor.subjectGeneration !== session.subjectGeneration ||
      context.actor.sessionId !== session.identitySessionRef || context.actor.sessionEpoch !== session.identitySessionEpoch ||
      context.actor.restrictionEpoch !== session.restrictionEpoch || session.siteRef !== workload.siteRef ||
      context.trustedCaller.kind !== "site_product" || context.trustedCaller.siteId !== workload.siteRef ||
      context.trustedCaller.siteReleaseRef !== workload.siteReleaseRef ||
      context.trustedCaller.workloadIdentityId !== workload.workloadIdentityId ||
      context.trustedCaller.bindingEpoch !== workload.bindingEpoch ||
      context.trustedCaller.siteSecurityEpoch !== workload.siteSecurityEpoch ||
      context.policyEpoch !== workload.policyEpoch || context.environment !== workload.environment ||
      context.region !== workload.region || context.audience !== workload.audience) {
    throw new Error("MEDIA_PUBLIC_NOT_AVAILABLE");
  }
  return Object.freeze({ siteRef: workload.siteRef, siteReleaseRef: workload.siteReleaseRef,
    siteProjectBindingRef: workload.siteProjectBindingRef, deploymentRef: workload.deploymentRef,
    workloadIdentityRef: workload.workloadIdentityId, workloadBindingEpoch: positive(workload.bindingEpoch),
    siteSecurityEpoch: positive(workload.siteSecurityEpoch), policyEpoch: positive(workload.policyEpoch),
    environment: workload.environment, region: workload.region, audience: workload.audience,
    subjectRef: session.subjectRef, subjectGeneration: positive(session.subjectGeneration),
    identitySessionRef: session.identitySessionRef,
    identitySessionEpoch: positive(session.identitySessionEpoch),
    restrictionEpoch: positive(session.restrictionEpoch), credentialEpoch: positive(session.credentialEpoch),
    projectRef });
}

function definitionView(record: MediaPublicDefinitionRecord): ImageTextToImageOperationDefinition {
  if (record.definitionKey !== "image.text_to_image@v1" || record.mediaKind !== "image_text_to_image" ||
      record.promptMaximumUtf8Bytes !== 32768) throw new Error("MEDIA_PUBLIC_DEFINITION_CORRUPT");
  return Object.freeze({ definitionKey: record.definitionKey, definitionRef: record.definitionKey,
    definitionRevisionRef: record.definitionRevisionRef, kind: record.mediaKind,
    title: "Text to image", description: "Generate images from a text prompt.",
    maximumCandidateCount: record.maximumCandidateCount,
    promptMaximumUtf8Bytes: record.promptMaximumUtf8Bytes,
    supportedAspectRatios: [...record.supportedAspectRatios],
    supportedOutputFormats: [...record.supportedOutputFormats],
    modelOptionCatalogRevisionRef: record.modelOptionCatalogRevisionRef,
    publishedAt: canonicalInstant(record.publishedAt) });
}

function modelOptionView(record: MediaPublicModelOptionRecord): PublishedModelOption {
  return Object.freeze({ modelOptionRevisionRef: record.modelOptionRevisionRef,
    optionKey: record.optionKey, label: record.label,
    ...(record.description === null ? {} : { description: record.description }),
    inputModalities: [...record.inputModalities], outputModalities: [...record.outputModalities],
    supportedEfforts: [...record.supportedEfforts], badges: [...record.badges],
    availability: record.availability });
}

function operationView(record: MediaPublicOperationRecord): MediaOperationView {
  const state = record.state;
  const base = Object.freeze({ operationRef: record.operationRef, definitionRef: record.definitionKey,
    definitionRevisionRef: record.definitionRevisionRef,
    modelOptionRevisionRef: record.modelOptionRevisionRef, ownerVersion: uint64(record.ownerVersion),
    progressBps: operationProgress(record), candidates: record.candidates.map(candidateView),
    costProjection: costProjection(record), createdAt: canonicalInstant(record.createdAt),
    updatedAt: canonicalInstant(record.updatedAt) });
  if (state === "failed") {
    return Object.freeze({ ...base, state, outcomeClass: terminalOutcome(record),
      safeFailure: operationFailure(record.terminalFailure) });
  }
  if (state === "completed" || state === "partial" || state === "canceled") {
    return Object.freeze({ ...base, state, outcomeClass: terminalOutcome(record) });
  }
  return Object.freeze({ ...base, state });
}

function candidateView(record: MediaPublicCandidateRecord): MediaCandidateView {
  const common = { candidateRef: record.candidateRef, ordinal: record.ordinal,
    ownerVersion: uint64(record.ownerVersion), state: record.state };
  if (record.state === "ready") return Object.freeze({ ...common, state: record.state,
    artifactRef: record.artifactRef, artifactVersionRef: record.artifactVersionRef });
  if (record.state === "restricted") return Object.freeze({ ...common, state: record.state,
    safeFailure: safeFailure("artifact_restricted", "never", "The generated artifact is restricted.") });
  if (record.state === "failed") return Object.freeze({ ...common, state: record.state,
    safeFailure: safeFailure("generation_failed", "never", "The image could not be generated.") });
  return Object.freeze(common) as MediaCandidateView;
}

function costProjection(record: MediaPublicOperationRecord): MediaOperationView["costProjection"] {
  if (record.financialReceiptRef === null && record.actualCost === null && record.terminalCreditUnit === null) {
    return null;
  }
  if (record.financialReceiptRef === null || record.actualCost === null || record.actualCost < 0n ||
      record.terminalCreditUnit === null) throw new Error("MEDIA_PUBLIC_FINANCIAL_PROJECTION_CORRUPT");
  return Object.freeze({ state: "final" as const, costProjectionRef: record.financialReceiptRef,
    freshness: "current" as const, ownerVersion: uint64(record.ownerVersion),
    amount: Object.freeze({ amount: record.actualCost.toString(), creditUnit: record.terminalCreditUnit }) });
}

function operationFailure(value: unknown): MediaSafeFailure {
  if (record(value)?.kind === "gateway_effect_failed") {
    return safeFailure("generation_failed", "never", "The image could not be generated.");
  }
  if (["minimum_ready_candidates_not_met", "partial_completion_forbidden"].includes(String(record(value)?.kind))) {
    return safeFailure("artifact_restricted", "never", "The generated artifacts were not available.");
  }
  return safeFailure("temporarily_unavailable", "after_delay", "The operation is temporarily unavailable.");
}

function safeFailure(code: MediaSafeFailure["code"], retryClass: MediaSafeFailure["retryClass"],
  safeMessage: string): MediaSafeFailure {
  return Object.freeze({ code, retryClass, safeMessage });
}

function terminalOutcome(record: MediaPublicOperationRecord): "canonical" | "irreconcilable" {
  if (record.outcomeClass !== "canonical" && record.outcomeClass !== "irreconcilable") {
    throw new Error("MEDIA_PUBLIC_TERMINAL_PROJECTION_CORRUPT");
  }
  return record.outcomeClass;
}

function operationProgress(record: MediaPublicOperationRecord): number {
  if (["completed", "partial", "failed", "canceled"].includes(record.state)) return 10_000;
  if (record.state === "finalizing" || record.state === "reconciling") return 9_000;
  if (record.state === "admission_pending") return 0;
  if (record.state === "authorized") return 500;
  if (record.state === "queued") return 1_000;
  const progress = record.candidates.length === 0 ? 0 : Math.floor(record.candidates
    .reduce((sum, candidate) => sum + candidateProgress(candidate.state), 0) / record.candidates.length);
  return Math.min(record.state === "cancel_requested" ? 9_500 : 8_999, 1_000 + Math.floor(progress * 0.8));
}

function candidateProgress(state: MediaPublicCandidateRecord["state"]): number {
  if (state === "allocated" || state === "unknown") return 0;
  if (state === "producing" || state === "cancel_requested") return 2_500;
  if (state === "output_received") return 5_000;
  if (state === "validating") return 7_500;
  return 10_000;
}

function boundedLimit(value: number | undefined): number {
  const limit = value ?? DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAXIMUM_LIMIT) throw new Error("INVALID_REQUEST");
  return limit;
}
function positive(value: string): bigint {
  if (!/^[1-9][0-9]{0,19}$/u.test(value)) throw new Error("MEDIA_PUBLIC_NOT_AVAILABLE");
  const parsed = BigInt(value);
  if (parsed > 9_223_372_036_854_775_807n) throw new Error("MEDIA_PUBLIC_NOT_AVAILABLE");
  return parsed;
}
function uint64(value: bigint): string {
  if (value < 1n || value > 18_446_744_073_709_551_615n) throw new Error("MEDIA_PUBLIC_PROJECTION_CORRUPT");
  return value.toString();
}
function reference(value: string): string {
  if (value.length < 1 || value.length > 256 || value.trim() !== value || /[\0\r\n]/u.test(value)) {
    throw new Error("INVALID_REQUEST");
  }
  return value;
}
function canonicalInstant(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("MEDIA_PUBLIC_PROJECTION_CORRUPT");
  return date.toISOString();
}
function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}
