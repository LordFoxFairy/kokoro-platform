import type { VerifiedRequestSecurityContext } from "../../../../shared/security-context/index.js";
import type { PlatformUnitOfWork } from "../../../../shared/unit-of-work/index.js";
import type {
  ModelControlRepository,
  ModelInventoryActivationAdministration,
  ModelInventoryActivationReceipt,
} from "../contracts/model-control-ports.js";
import type { ModelControlCommandJournal } from "../contracts/model-control-command-journal.js";
import {
  assertModelControlCommandId,
  createModelControlCommand,
  modelControlSecurityFacts,
} from "../model-control-command.js";

export class ActivateModelInventoryService implements ModelInventoryActivationAdministration {
  constructor(
    private readonly unitOfWork: PlatformUnitOfWork,
    private readonly repository: ModelControlRepository,
    private readonly journal: ModelControlCommandJournal,
  ) {}

  activate(
    input: Parameters<ModelInventoryActivationAdministration["activate"]>[0],
    context: VerifiedRequestSecurityContext,
  ): Promise<ModelInventoryActivationReceipt> {
    assertModelControlCommandId(input.activationId, "MODEL_ACTIVATION_ID_INVALID");
    if (!/^[a-f0-9]{64}$/u.test(input.targetDigest))
      throw new Error("MODEL_ACTIVATION_TARGET_INVALID");
    if (!/^(?:0|[1-9][0-9]*)$/u.test(input.expectedPointerRevision))
      throw new Error("MODEL_POINTER_REVISION_INVALID");
    if (context.trustedCaller.kind !== "admin_workload")
      throw new Error("MODEL_INVENTORY_ACTIVATION_ADMIN_WORKLOAD_REQUIRED");
    if (context.actor.kind !== "operator" && context.actor.kind !== "workload")
      throw new Error("MODEL_INVENTORY_ACTIVATION_MANAGEMENT_PRINCIPAL_REQUIRED");
    const command = createModelControlCommand({
      commandId: input.activationId,
      idempotencyKey: input.idempotencyKey ?? input.activationId,
      requestDigest: input.requestDigest,
      operation: "model.inventory.activate",
      security: modelControlSecurityFacts(context),
      effect: {
        targetDigest: input.targetDigest,
        expectedPointerRevision: input.expectedPointerRevision,
      },
    });
    return this.unitOfWork.execute(
      { context, operation: "model.inventory.activate" },
      async (transaction) => {
        await this.journal.begin(transaction, command);
        const receipt = await this.repository.activateInventory(transaction, {
          activationId: input.activationId,
          activatedBy: context.actor.subjectId,
          targetDigest: input.targetDigest,
          expectedPointerRevision: input.expectedPointerRevision,
        });
        await this.journal.succeed(transaction, command, receipt, context);
        return receipt;
      },
    );
  }
}
