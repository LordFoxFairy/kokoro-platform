import type { VerifiedRequestSecurityContext } from "../../../shared/security-context/index.js";
import type { PlatformTransaction } from "../../../shared/unit-of-work/index.js";
import type { AdminOperatorAuthority } from "../domain/admin-command.js";
import type { AdminUnitOfWorkPort } from "./admin-command-service.js";

export interface AdminPostEffectReviewRecord {
  readonly reviewRef: string;
  readonly commandId: string;
  readonly operation: string;
  readonly requiredPermission: string;
  readonly makerRef: string;
  readonly makerGeneration: bigint;
  readonly makerAuthorizationEpoch: bigint;
  readonly siteRef: string | null;
  readonly environment: string;
  readonly region: string;
  readonly state: "pending" | "acknowledged" | "escalated" | "expired";
  readonly revision: bigint;
  readonly expiresAt: string;
}

export interface AdminPostEffectReviewRepositoryPort {
  lockReview(
    transaction: PlatformTransaction,
    reviewRef: string,
  ): Promise<AdminPostEffectReviewRecord | null>;
  lockOperatorAuthority(
    transaction: PlatformTransaction,
    identity: Readonly<{ operatorRef: string; operatorGeneration: bigint }>,
  ): Promise<AdminOperatorAuthority | null>;
  transitionReview(
    transaction: PlatformTransaction,
    input: Readonly<{
      reviewRef: string;
      expectedRevision: bigint;
      state: "acknowledged" | "escalated";
      reviewerRef: string;
      reviewerGeneration: bigint;
      reviewerAuthorizationEpoch: bigint;
      reason: string;
      reviewedAt: string;
    }>,
  ): Promise<boolean>;
}

export class AdminPostEffectReviewService {
  constructor(private readonly dependencies: Readonly<{
    unitOfWork: AdminUnitOfWorkPort;
    repository: AdminPostEffectReviewRepositoryPort;
    clock?: () => Date;
  }>) {}

  async decide(input: Readonly<{
    context: VerifiedRequestSecurityContext;
    reviewRef: string;
    decision: "acknowledge" | "escalate";
    reason: string;
  }>): Promise<Readonly<{
    disposition: "acknowledged" | "escalated";
    reviewRef: string;
  }>> {
    bounded(input.reviewRef, "ADMIN_POST_EFFECT_REVIEW_REF_INVALID");
    const reason = input.reason.trim();
    if (reason.length < 3 || reason.length > 512) {
      throw new Error("ADMIN_POST_EFFECT_REVIEW_REASON_INVALID");
    }
    return this.dependencies.unitOfWork.execute(
      { context: input.context, operation: "admin.break-glass.review" },
      async (transaction) => {
        const review = await this.dependencies.repository.lockReview(transaction, input.reviewRef);
        if (review === null || review.state !== "pending") {
          throw new Error("ADMIN_POST_EFFECT_REVIEW_NOT_PENDING");
        }
        const now = this.now();
        if (Date.parse(review.expiresAt) <= Date.parse(now)) {
          throw new Error("ADMIN_POST_EFFECT_REVIEW_EXPIRED");
        }
        const context = input.context;
        if (context.trustedCaller.kind !== "admin_workload" || context.actor.kind !== "operator" ||
          context.target.purpose !== "admin.break-glass.review" ||
          !context.trustedCaller.allowedOperations.includes("admin.break-glass.review") ||
          context.environment !== review.environment || context.region !== review.region ||
          context.target.siteId !== review.siteRef) {
          throw new Error("ADMIN_POST_EFFECT_REVIEW_CONTEXT_INVALID");
        }
        if (context.actor.subjectId === review.makerRef) {
          throw new Error("ADMIN_POST_EFFECT_REVIEW_INDEPENDENCE_REQUIRED");
        }
        if (context.actor.assuranceLevel !== "phishing_resistant" ||
          context.actor.stepUpAt === undefined || context.actor.stepUpAt === null ||
          Date.parse(context.actor.stepUpAt) > Date.parse(now) ||
          Date.parse(now) - Date.parse(context.actor.stepUpAt) > 5 * 60_000) {
          throw new Error("ADMIN_POST_EFFECT_REVIEW_STEP_UP_REQUIRED");
        }
        const generation = epoch(context.actor.subjectGeneration);
        const authority = await this.dependencies.repository.lockOperatorAuthority(transaction, {
          operatorRef: context.actor.subjectId,
          operatorGeneration: generation,
        });
        if (authority === null || authority.state !== "active" ||
          authority.operatorGeneration !== generation || Date.parse(authority.expiresAt) <= Date.parse(now) ||
          !authority.environments.includes(review.environment) || !authority.regions.includes(review.region) ||
          !scoped(authority, review.siteRef) || !permits(authority.permissions, "admin.break-glass.review") ||
          !permits(authority.permissions, review.requiredPermission)) {
          throw new Error("ADMIN_POST_EFFECT_REVIEW_AUTHORITY_INVALID");
        }
        const state = input.decision === "acknowledge" ? "acknowledged" : "escalated";
        const changed = await this.dependencies.repository.transitionReview(transaction, {
          reviewRef: review.reviewRef,
          expectedRevision: review.revision,
          state,
          reviewerRef: authority.operatorRef,
          reviewerGeneration: authority.operatorGeneration,
          reviewerAuthorizationEpoch: authority.authorizationEpoch,
          reason,
          reviewedAt: now,
        });
        if (!changed) throw new Error("ADMIN_POST_EFFECT_REVIEW_CONCURRENT_DECISION");
        return Object.freeze({ disposition: state, reviewRef: review.reviewRef });
      },
    );
  }

  private now(): string {
    return (this.dependencies.clock ?? (() => new Date()))().toISOString();
  }
}

function permits(values: readonly string[], required: string): boolean {
  return values.includes(required) || values.some((value) =>
    value.endsWith(".*") && required.startsWith(value.slice(0, -1)));
}

function scoped(authority: AdminOperatorAuthority, siteRef: string | null): boolean {
  return siteRef === null
    ? authority.globalScopes.length > 0
    : authority.siteScopes.includes(siteRef);
}

function epoch(value: string): bigint {
  if (!/^[1-9][0-9]*$/u.test(value)) {
    throw new Error("ADMIN_POST_EFFECT_REVIEW_GENERATION_INVALID");
  }
  return BigInt(value);
}

function bounded(value: string, code: string): void {
  if (value.length < 8 || value.length > 128 || [...value].some((character) => {
    const point = character.codePointAt(0) ?? 0;
    return point < 32 || point === 127;
  })) {
    throw new Error(code);
  }
}
