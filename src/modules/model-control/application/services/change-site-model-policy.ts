import type { VerifiedRequestSecurityContext } from "../../../../shared/security-context/index.js";
import type { PlatformUnitOfWork } from "../../../../shared/unit-of-work/index.js";
import { canonicalizeSiteModelPolicy } from "../../domain/site-model-policy.js";
import type {
  ModelControlRepository,
  SiteModelPolicyAdministration,
  SiteModelPolicyChangeReceipt,
} from "../contracts/model-control-ports.js";
import type { ModelControlCommandJournal } from "../contracts/model-control-command-journal.js";
import {
  assertModelControlCommandId,
  createModelControlCommand,
  modelControlSecurityFacts,
} from "../model-control-command.js";

export class ChangeSiteModelPolicyService implements SiteModelPolicyAdministration {
  constructor(
    private readonly unitOfWork: PlatformUnitOfWork,
    private readonly repository: ModelControlRepository,
    private readonly journal: ModelControlCommandJournal,
  ) {}

  change(
    input: Parameters<SiteModelPolicyAdministration["change"]>[0],
    context: VerifiedRequestSecurityContext,
  ): Promise<SiteModelPolicyChangeReceipt> {
    assertModelControlCommandId(input.changeId, "MODEL_SITE_POLICY_CHANGE_ID_INVALID");
    if (!/^(?:0|[1-9][0-9]*)$/u.test(input.expectedRevision))
      throw new Error("MODEL_SITE_POLICY_REVISION_INVALID");
    if (context.trustedCaller.kind !== "admin_workload")
      throw new Error("MODEL_SITE_POLICY_ADMIN_WORKLOAD_REQUIRED");
    if (context.actor.kind !== "operator" && context.actor.kind !== "workload")
      throw new Error("MODEL_SITE_POLICY_MANAGEMENT_PRINCIPAL_REQUIRED");
    const policy = canonicalizeSiteModelPolicy(input.policy);
    const crossSiteAdministration =
      context.target.siteId === null &&
      context.target.purpose === "model_control_administration" &&
      context.target.scopes.includes("model:site-policy:manage-all");
    if (context.target.siteId !== policy.document.siteId && !crossSiteAdministration)
      throw new Error("MODEL_SITE_SCOPE_MISMATCH");
    const command = createModelControlCommand({
      commandId: input.changeId,
      idempotencyKey: input.idempotencyKey ?? input.changeId,
      requestDigest: input.requestDigest,
      operation: "model.site-policy.change",
      security: modelControlSecurityFacts(context),
      effect: {
        siteId: policy.document.siteId,
        product: policy.document.product,
        policyDigest: policy.digest,
        expectedRevision: input.expectedRevision,
      },
    });
    return this.unitOfWork.execute(
      { context, operation: "model.site-policy.change" },
      async (transaction) => {
        await this.journal.begin(transaction, command);
        const receipt = await this.repository.putSitePolicy(transaction, {
          changeId: input.changeId,
          changedBy: context.actor.subjectId,
          expectedRevision: input.expectedRevision,
          policy,
        });
        await this.journal.succeed(transaction, command, receipt, context);
        return receipt;
      },
    );
  }
}
