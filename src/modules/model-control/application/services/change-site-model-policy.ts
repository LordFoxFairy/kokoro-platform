import type { VerifiedRequestSecurityContext } from "../../../../shared/security-context/index.js";
import type { PlatformUnitOfWork } from "../../../../shared/unit-of-work/index.js";
import { canonicalizeSiteModelPolicy } from "../../domain/site-model-policy.js";
import type {
  ModelControlRepository,
  SiteModelPolicyAdministration,
  SiteModelPolicyChangeReceipt,
} from "../contracts/model-control-ports.js";

export class ChangeSiteModelPolicyService implements SiteModelPolicyAdministration {
  constructor(
    private readonly unitOfWork: PlatformUnitOfWork,
    private readonly repository: ModelControlRepository,
  ) {}

  change(
    input: Parameters<SiteModelPolicyAdministration["change"]>[0],
    context: VerifiedRequestSecurityContext,
  ): Promise<SiteModelPolicyChangeReceipt> {
    if (!uuid(input.changeId)) throw new Error("MODEL_SITE_POLICY_CHANGE_ID_INVALID");
    if (!/^(?:0|[1-9][0-9]*)$/u.test(input.expectedRevision))
      throw new Error("MODEL_SITE_POLICY_REVISION_INVALID");
    if (context.trustedCaller.kind !== "admin_workload")
      throw new Error("MODEL_SITE_POLICY_ADMIN_WORKLOAD_REQUIRED");
    if (context.actor.kind !== "operator" && context.actor.kind !== "workload")
      throw new Error("MODEL_SITE_POLICY_MANAGEMENT_PRINCIPAL_REQUIRED");
    const policy = canonicalizeSiteModelPolicy(input.policy);
    const crossSiteMigration =
      context.target.siteId === null &&
      context.target.purpose === "model_control_migration" &&
      context.target.scopes.includes("model:site-policy:migrate");
    if (context.target.siteId !== policy.document.siteId && !crossSiteMigration)
      throw new Error("MODEL_SITE_SCOPE_MISMATCH");
    return this.unitOfWork.execute(
      { context, operation: "model.site-policy.change" },
      (transaction) =>
        this.repository.putSitePolicy(transaction, {
          changeId: input.changeId,
          changedBy: context.actor.subjectId,
          expectedRevision: input.expectedRevision,
          policy,
        }),
    );
  }
}

function uuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}
