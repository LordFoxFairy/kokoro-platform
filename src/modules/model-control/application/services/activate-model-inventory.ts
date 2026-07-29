import type { VerifiedRequestSecurityContext } from "../../../../shared/security-context/index.js";
import type { PlatformUnitOfWork } from "../../../../shared/unit-of-work/index.js";
import type {
  ModelControlRepository,
  ModelInventoryActivationAdministration,
  ModelInventoryActivationReceipt,
} from "../contracts/model-control-ports.js";

export class ActivateModelInventoryService implements ModelInventoryActivationAdministration {
  constructor(
    private readonly unitOfWork: PlatformUnitOfWork,
    private readonly repository: ModelControlRepository,
  ) {}

  activate(
    input: Parameters<ModelInventoryActivationAdministration["activate"]>[0],
    context: VerifiedRequestSecurityContext,
  ): Promise<ModelInventoryActivationReceipt> {
    if (!uuid(input.activationId)) throw new Error("MODEL_ACTIVATION_ID_INVALID");
    if (!/^[a-f0-9]{64}$/u.test(input.targetDigest))
      throw new Error("MODEL_ACTIVATION_TARGET_INVALID");
    if (!/^(?:0|[1-9][0-9]*)$/u.test(input.expectedPointerRevision))
      throw new Error("MODEL_POINTER_REVISION_INVALID");
    if (context.trustedCaller.kind !== "admin_workload")
      throw new Error("MODEL_INVENTORY_ACTIVATION_ADMIN_WORKLOAD_REQUIRED");
    if (context.actor.kind !== "operator" && context.actor.kind !== "workload")
      throw new Error("MODEL_INVENTORY_ACTIVATION_MANAGEMENT_PRINCIPAL_REQUIRED");
    return this.unitOfWork.execute(
      { context, operation: "model.inventory.activate" },
      (transaction) =>
        this.repository.activateInventory(transaction, {
          activationId: input.activationId,
          activatedBy: context.actor.subjectId,
          targetDigest: input.targetDigest,
          expectedPointerRevision: input.expectedPointerRevision,
        }),
    );
  }
}

function uuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}
