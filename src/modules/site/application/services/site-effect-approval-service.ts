import type { VerifiedRequestSecurityContext } from "../../../../shared/security-context/index.js";
import type { PlatformUnitOfWork } from "../../../../shared/unit-of-work/index.js";
import type {
  SiteDangerousOperation,
  SiteEffectApprovalAdministration,
} from "../contracts/site-effect-approval.js";

export interface SiteEffectApprovalReceipt {
  readonly approvalRef: string;
  readonly state: "pending" | "approved" | "consumed";
  readonly recordedAt?: string;
  readonly expiresAt?: string;
}

export class SiteEffectApprovalService {
  readonly #now: () => string;
  readonly #approvalLifetimeMs: number;

  constructor(
    private readonly unitOfWork: PlatformUnitOfWork,
    private readonly authority: SiteEffectApprovalAdministration,
    options: Readonly<{ now?: () => string; approvalLifetimeMs?: number }> = {},
  ) {
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#approvalLifetimeMs = options.approvalLifetimeMs ?? 10 * 60 * 1_000;
    if (!Number.isSafeInteger(this.#approvalLifetimeMs) || this.#approvalLifetimeMs < 60_000 ||
        this.#approvalLifetimeMs > 30 * 60 * 1_000) {
      throw new Error("SITE_APPROVAL_LIFETIME_INVALID");
    }
  }

  request(
    input: Readonly<{ approvalRef: string; siteRef: string; operation: SiteDangerousOperation;
      effectDigest: string; reason: string; commandId: string; idempotencyKey: string;
      requestDigest: string }>,
    context: VerifiedRequestSecurityContext,
  ): Promise<SiteEffectApprovalReceipt> {
    admin(context, input.siteRef);
    const requestedAt = this.#now();
    const expiresAt = new Date(Date.parse(requestedAt) + this.#approvalLifetimeMs).toISOString();
    return this.unitOfWork.execute({ context, operation: "site.approval.request" }, async (transaction) => {
      return this.authority.request(transaction, {
        ...input, environment: context.environment, region: context.region,
        makerSubjectRef: context.actor.subjectId, requestedAt, expiresAt,
      });
    });
  }

  approve(
    input: Readonly<{ approvalRef: string; siteRef: string; operation: SiteDangerousOperation;
      effectDigest: string }>,
    context: VerifiedRequestSecurityContext,
  ): Promise<SiteEffectApprovalReceipt> {
    admin(context, input.siteRef);
    const decidedAt = this.#now();
    return this.unitOfWork.execute({ context, operation: "site.approval.approve" }, async (transaction) => {
      await this.authority.approve(transaction, {
        ...input, environment: context.environment, region: context.region,
        checkerSubjectRef: context.actor.subjectId, decidedAt,
      });
      return Object.freeze({ approvalRef: input.approvalRef, state: "approved" });
    });
  }
}

function admin(context: VerifiedRequestSecurityContext, siteRef: string): void {
  if (context.trustedCaller.kind !== "admin_workload" || context.actor.kind !== "operator") {
    throw new Error("SITE_ADMIN_OPERATOR_REQUIRED");
  }
  if (context.target.siteId !== siteRef) throw new Error("SITE_ADMIN_SCOPE_MISMATCH");
}
