import type { VerifiedRequestSecurityContext } from "../../../../shared/security-context/index.js";
import type { PlatformUnitOfWork } from "../../../../shared/unit-of-work/index.js";
import { materializeModelOptionDraftSet } from "../../domain/model-option-materialization.js";
import type { ModelControlCommandJournal } from "../contracts/model-control-command-journal.js";
import type {
  ModelOptionCatalogRepository,
  ModelOptionMaterializationAdministration,
  ModelOptionMaterializationReceipt,
} from "../contracts/product-model-option-ports.js";
import {
  assertModelControlCommandId,
  createModelControlCommand,
  modelControlSecurityFacts,
} from "../model-control-command.js";

export class MaterializeModelOptionsService implements ModelOptionMaterializationAdministration {
  constructor(
    private readonly unitOfWork: PlatformUnitOfWork,
    private readonly repository: ModelOptionCatalogRepository,
    private readonly journal: ModelControlCommandJournal,
  ) {}

  materialize(
    input: Parameters<ModelOptionMaterializationAdministration["materialize"]>[0],
    context: VerifiedRequestSecurityContext,
  ): Promise<ModelOptionMaterializationReceipt> {
    assertModelControlCommandId(input.materializationId, "MODEL_OPTION_MATERIALIZATION_ID_INVALID");
    digest(input.inventoryDigest, "MODEL_OPTION_INVENTORY_DIGEST_INVALID");
    if (
      context.trustedCaller.kind !== "admin_workload" ||
      (context.actor.kind !== "operator" && context.actor.kind !== "workload") ||
      context.target.siteId !== null ||
      context.target.purpose !== "model_control_administration"
    ) throw new Error("MODEL_OPTION_MATERIALIZATION_ADMIN_CONTEXT_REQUIRED");

    return this.unitOfWork.execute(
      { context, operation: "model.option.materialize" },
      async (transaction) => {
        const inventory = await this.repository.loadInventory(transaction, input.inventoryDigest);
        if (inventory === null || inventory.digest !== input.inventoryDigest) {
          throw new Error("MODEL_OPTION_INVENTORY_NOT_FOUND");
        }
        const materialization = materializeModelOptionDraftSet({
          inventory,
          draftSet: {
            schemaVersion: 1,
            inventoryDigest: input.inventoryDigest,
            options: input.options,
          },
        });
        const command = createModelControlCommand({
          commandId: input.materializationId,
          idempotencyKey: input.idempotencyKey ?? input.materializationId,
          requestDigest: input.requestDigest,
          operation: "model.option.materialize",
          security: modelControlSecurityFacts(context),
          effect: {
            sourceDigest: materialization.sourceDigest,
            inventoryDigest: materialization.inventoryDigest,
            materializationDigest: materialization.materializationDigest,
            compilerVersion: materialization.compilerVersion,
          },
        });
        await this.journal.begin(transaction, command);
        const receipt = await this.repository.materializeOptions(transaction, {
          materializationId: input.materializationId,
          materializedBy: context.actor.subjectId,
          materialization,
        });
        assertMaterializationReceipt(receipt, input.materializationId, materialization);
        await this.journal.succeed(transaction, command, receipt, context);
        return receipt;
      },
    );
  }
}

function assertMaterializationReceipt(
  receipt: ModelOptionMaterializationReceipt,
  materializationId: string,
  materialization: ReturnType<typeof materializeModelOptionDraftSet>,
): void {
  const expectedRefs = materialization.optionRevisions.map(({ modelOptionRevisionRef }) =>
    modelOptionRevisionRef);
  if (
    receipt.materializationId !== materializationId ||
    receipt.sourceDigest !== materialization.sourceDigest ||
    receipt.inventoryDigest !== materialization.inventoryDigest ||
    receipt.materializationDigest !== materialization.materializationDigest ||
    receipt.optionRevisionRefs.length !== expectedRefs.length ||
    receipt.optionRevisionRefs.some((value, index) => value !== expectedRefs[index]) ||
    typeof receipt.replayed !== "boolean"
  ) throw new Error("MODEL_OPTION_MATERIALIZATION_RECEIPT_INVALID");
}

function digest(value: string, code: string): void {
  if (!/^[a-f0-9]{64}$/u.test(value)) throw new Error(code);
}
