import type { VerifiedRequestSecurityContext } from "../../../../shared/security-context/index.js";
import type { PlatformUnitOfWork } from "../../../../shared/unit-of-work/index.js";
import type {
  ModelControlRepository,
  ModelProviderAvailabilityReportReceipt,
  ModelProviderAvailabilityReporting,
} from "../contracts/model-control-ports.js";

export class ReportModelProviderAvailabilityService implements ModelProviderAvailabilityReporting {
  constructor(
    private readonly unitOfWork: PlatformUnitOfWork,
    private readonly repository: ModelControlRepository,
  ) {}

  report(
    input: Parameters<ModelProviderAvailabilityReporting["report"]>[0],
    context: VerifiedRequestSecurityContext,
  ): Promise<ModelProviderAvailabilityReportReceipt> {
    if (!uuid(input.reportId)) throw new Error("MODEL_AVAILABILITY_REPORT_ID_INVALID");
    if (!/^[a-z0-9][a-z0-9._:-]{0,127}$/u.test(input.providerKey))
      throw new Error("MODEL_AVAILABILITY_PROVIDER_INVALID");
    if (input.status !== "active" && input.status !== "disabled")
      throw new Error("MODEL_AVAILABILITY_STATUS_INVALID");
    if (!(["unknown", "healthy", "degraded", "down"] as const).includes(input.health))
      throw new Error("MODEL_AVAILABILITY_HEALTH_INVALID");
    if (!/^(?:0|[1-9][0-9]*)$/u.test(input.expectedEpoch))
      throw new Error("MODEL_AVAILABILITY_EPOCH_INVALID");
    if (input.observationRef !== null && !/^.{1,512}$/su.test(input.observationRef))
      throw new Error("MODEL_AVAILABILITY_OBSERVATION_REF_INVALID");
    const observedAt = input.observedAt === null ? null : canonicalInstant(input.observedAt);
    if (context.trustedCaller.kind !== "platform_worker" || context.actor.kind !== "workload")
      throw new Error("MODEL_AVAILABILITY_WORKER_REQUIRED");
    if (
      context.target.siteId !== null ||
      context.target.workspaceId !== null ||
      context.target.projectId !== null ||
      context.target.purpose !== "model_health_observation" ||
      !context.target.scopes.includes("model:availability:write")
    )
      throw new Error("MODEL_AVAILABILITY_GLOBAL_SCOPE_REQUIRED");

    return this.unitOfWork.execute(
      { context, operation: "model.availability.report" },
      (transaction) =>
        this.repository.reportProviderAvailability(transaction, {
          ...input,
          observedAt,
          reportedBy: context.actor.subjectId,
        }),
    );
  }
}

function uuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}

function canonicalInstant(value: string): string {
  const instant = new Date(value);
  if (!Number.isFinite(instant.getTime())) throw new Error("MODEL_AVAILABILITY_TIME_INVALID");
  return instant.toISOString();
}
