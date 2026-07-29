import type { VerifiedRequestSecurityContext } from "../../../../shared/security-context/index.js";
import type { PlatformUnitOfWork } from "../../../../shared/unit-of-work/index.js";
import { canonicalizeModelInventory } from "../../domain/model-catalog.js";
import type {
  ModelControlRepository,
  ModelInventoryImportAdministration,
  ModelInventoryImportReceipt,
} from "../contracts/model-control-ports.js";

export class ImportModelControlService implements ModelInventoryImportAdministration {
  constructor(
    private readonly unitOfWork: PlatformUnitOfWork,
    private readonly repository: ModelControlRepository,
  ) {}
  import(
    input: Parameters<ModelInventoryImportAdministration["import"]>[0],
    context: VerifiedRequestSecurityContext,
  ): Promise<ModelInventoryImportReceipt> {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
        input.importId,
      )
    )
      throw new Error("MODEL_IMPORT_ID_INVALID");
    const inventory = canonicalizeModelInventory(input.inventory);
    if (context.trustedCaller.kind !== "admin_workload")
      throw new Error("MODEL_INVENTORY_IMPORT_ADMIN_WORKLOAD_REQUIRED");
    if (context.actor.kind !== "operator" && context.actor.kind !== "workload")
      throw new Error("MODEL_INVENTORY_IMPORT_MANAGEMENT_PRINCIPAL_REQUIRED");
    return this.unitOfWork.execute(
      { context, operation: "model.inventory.import" },
      (transaction) =>
        this.repository.importInventory(transaction, {
          importId: input.importId,
          importedBy: context.actor.subjectId,
          inventory,
        }),
    );
  }
}
