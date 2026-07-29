import { createHash } from "node:crypto";
import type { VerifiedRequestSecurityContext } from "../../../../shared/security-context/index.js";
import type { PlatformUnitOfWork } from "../../../../shared/unit-of-work/unit-of-work.js";
import type { JsonValue } from "../../../../shared/outbox-inbox/receipt.js";
import { createCommerceCommandIdentity } from "../../domain/command-identity.js";
import {
  redemptionPreviewDigest,
  uuidV7,
  type StoredRedemptionPreview,
} from "../../domain/redemption-preview.js";
import type { RedemptionRepository } from "../contracts/redemption-repository.js";
import type { RedemptionSecretPort } from "../contracts/redemption-secret-port.js";
import type { CommerceCommandFence } from "../command-fence.js";
import { commerceCanonicalJson } from "../../domain/canonical-json.js";

export type RedemptionPreviewView = Readonly<{
  receipt: Readonly<{
    commandId: string;
    requestDigest: string;
    receiptRef: string;
    state: "committed";
    committedAt: string;
  }>;
  preview: Readonly<{
    previewRef: string;
    previewCredential: string;
    previewDigest: string;
    productRef: string;
    productVersionRef: string;
    productKind: "free" | "credit_pack" | "subscription" | "bundle";
    safeProductLabel: string;
    planRef: string | null;
    planVersionRef: string | null;
    safePlanLabel: string | null;
    term: StoredRedemptionPreview["safeTerms"]["term"];
    credits: StoredRedemptionPreview["safeTerms"]["credits"];
    entitlements: StoredRedemptionPreview["safeTerms"]["entitlements"];
    legalTermRefs: StoredRedemptionPreview["safeTerms"]["legalTermRefs"];
    expiresAt: string;
  }>;
}>;

export class PreviewRedemptionService {
  readonly #clock: () => Date;
  readonly #reference: (now: number) => string;
  readonly #ttlSeconds: number;

  constructor(private readonly dependencies: Readonly<{
    unitOfWork: PlatformUnitOfWork;
    fence: CommerceCommandFence;
    repository: RedemptionRepository;
    secrets: RedemptionSecretPort;
    clock?: () => Date;
    reference?: (now: number) => string;
    previewTtlSeconds?: number;
  }>) {
    this.#clock = dependencies.clock ?? (() => new Date());
    this.#reference = dependencies.reference ?? ((now) => uuidV7(now));
    this.#ttlSeconds = dependencies.previewTtlSeconds ?? 300;
    if (!Number.isInteger(this.#ttlSeconds) || this.#ttlSeconds < 60 || this.#ttlSeconds > 900) {
      throw new Error("REDEMPTION_PREVIEW_TTL_INVALID");
    }
  }

  async execute(input: Readonly<{
    context: VerifiedRequestSecurityContext;
    commandId: string;
    idempotencyKey: string;
    code: string;
  }>): Promise<RedemptionPreviewView> {
    const siteId = input.context.target.siteId;
    if (input.context.actor.kind !== "user" || siteId === null) throw new Error("COMMERCE_EFFECT_NOT_AUTHORIZED");
    const requestDigest = this.dependencies.secrets.previewRequestDigest({
      siteId,
      subjectId: input.context.actor.subjectId,
      subjectGeneration: input.context.actor.subjectGeneration,
      code: input.code,
    });
    const identity = createCommerceCommandIdentity({
      commandId: input.commandId,
      environment: input.context.environment,
      region: input.context.region,
      siteId,
      actorKind: "user",
      actorSubject: input.context.actor.subjectId,
      actorGeneration: input.context.actor.subjectGeneration,
      operation: "previewRedemption",
      idempotencyKey: input.idempotencyKey,
      commandVersion: "redemption-preview-v1",
      requestDigest,
    });
    let created: StoredRedemptionPreview | null = null;
    const execution = await this.dependencies.fence.execute({ context: input.context, identity }, async ({ transaction }) => {
      const now = this.#clock();
      const issuedAt = now.toISOString();
      const expiresAt = new Date(now.getTime() + this.#ttlSeconds * 1000).toISOString();
      const billing = await this.dependencies.repository.resolvePreviewBillingAccount(transaction, {
        siteId: identity.siteId,
        subjectId: identity.actorSubject,
        subjectGeneration: identity.actorGeneration,
      });
      if (billing === null) throw new Error("REDEEM_NOT_ACCEPTED");
      const candidate = await this.dependencies.repository.resolvePreviewCandidate(transaction, {
        siteId: identity.siteId,
        billingAccountId: billing.billingAccountId,
        lookupCandidates: this.dependencies.secrets.codeLookupCandidates(input.code, identity.siteId),
        now: issuedAt,
      });
      if (candidate === null) throw new Error("REDEEM_NOT_ACCEPTED");
      const previewRef = this.#reference(now.getTime());
      const previewCredential = this.dependencies.secrets.previewCredential(previewRef);
      const verifiedCredential = this.dependencies.secrets.verifyPreviewCredential(previewCredential);
      if (verifiedCredential === null) throw new Error("REDEMPTION_PREVIEW_CREDENTIAL_ISSUE_FAILED");
      const previewDigest = redemptionPreviewDigest({
        siteId: identity.siteId,
        subjectId: identity.actorSubject,
        subjectGeneration: identity.actorGeneration,
        billingAccountId: billing.billingAccountId,
        candidate,
        expiresAt,
      });
      created = Object.freeze({
        ...candidate,
        previewRef,
        commandId: identity.commandId,
        siteId: identity.siteId,
        subjectId: identity.actorSubject,
        subjectGeneration: identity.actorGeneration,
        billingAccountId: billing.billingAccountId,
        previewDigest,
        credentialKeyRevision: verifiedCredential.keyRevision,
        credentialDigest: verifiedCredential.credentialDigest,
        state: "live" as const,
        expiresAt,
        createdAt: issuedAt,
      });
      await this.dependencies.repository.savePreview(transaction, created);
      const result: JsonValue = Object.freeze({
        kind: "redemption_preview",
        previewRef,
        committedAt: issuedAt,
      });
      return Object.freeze({ state: "succeeded" as const, result, resultDigest: digest(result) });
    });
    if (execution.disposition === "in_progress" ||
      (execution.disposition === "replay" && execution.receipt.state !== "succeeded")) {
      throw new Error("REDEEM_TEMPORARILY_UNAVAILABLE");
    }
    const stored = created ?? await this.dependencies.unitOfWork.execute(
      { context: input.context, operation: "previewRedemption" },
      (transaction) => this.dependencies.repository.findPreviewByCommand(transaction, {
        siteId: identity.siteId,
        subjectId: identity.actorSubject,
        subjectGeneration: identity.actorGeneration,
        commandId: identity.commandId,
      }),
    );
    if (stored === null) throw new Error("REDEEM_TEMPORARILY_UNAVAILABLE");
    if (Date.parse(stored.expiresAt) <= this.#clock().getTime()) throw new Error("REDEEM_NOT_ACCEPTED");
    let previewCredential: string;
    try {
      previewCredential = this.dependencies.secrets.previewCredential(stored.previewRef, stored.credentialKeyRevision);
    } catch (error) {
      if (error instanceof Error && error.message === "REDEMPTION_PREVIEW_KEY_RETIRED") {
        throw new Error("REDEEM_NOT_ACCEPTED");
      }
      throw error;
    }
    const verified = this.dependencies.secrets.verifyPreviewCredential(previewCredential);
    if (verified === null || verified.credentialDigest !== stored.credentialDigest) {
      throw new Error("REDEEM_TEMPORARILY_UNAVAILABLE");
    }
    return view(stored, requestDigest, previewCredential);
  }
}

function view(stored: StoredRedemptionPreview, requestDigest: string, previewCredential: string): RedemptionPreviewView {
  return Object.freeze({
    receipt: Object.freeze({
      commandId: stored.commandId,
      requestDigest,
      receiptRef: `commerce-command:${stored.commandId}`,
      state: "committed" as const,
      committedAt: stored.createdAt,
    }),
    preview: Object.freeze({
      previewRef: stored.previewRef,
      previewCredential,
      previewDigest: stored.previewDigest,
      ...stored.safeTerms,
      expiresAt: stored.expiresAt,
    }),
  });
}

function digest(value: JsonValue): string {
  return createHash("sha256").update(commerceCanonicalJson(value), "utf8").digest("hex");
}
