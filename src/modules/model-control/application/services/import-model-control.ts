import type { VerifiedRequestSecurityContext } from "../../../../shared/security-context/index.js";
import type { PlatformUnitOfWork } from "../../../../shared/unit-of-work/index.js";
import { canonicalizeModelInventory } from "../../domain/model-catalog.js";
import {
  assertInventoryUsesDirectModelProviderIdentity,
} from "../../domain/direct-model-provider-identity.js";
import { canonicalizeProviderOperationalAvailability } from "../../domain/provider-availability.js";
import type {
  ModelControlRepository,
  ModelInventoryImportAdministration,
  ModelInventoryImportReceipt,
} from "../contracts/model-control-ports.js";
import type { ModelControlCommandJournal } from "../contracts/model-control-command-journal.js";
import {
  assertModelControlCommandId,
  createModelControlCommand,
  modelControlSecurityFacts,
} from "../model-control-command.js";

export class ImportModelControlService implements ModelInventoryImportAdministration {
  constructor(
    private readonly unitOfWork: PlatformUnitOfWork,
    private readonly repository: ModelControlRepository,
    private readonly journal: ModelControlCommandJournal,
  ) {}
  import(
    input: Parameters<ModelInventoryImportAdministration["import"]>[0],
    context: VerifiedRequestSecurityContext,
  ): Promise<ModelInventoryImportReceipt> {
    assertModelControlCommandId(input.importId, "MODEL_IMPORT_ID_INVALID");
    const inventory = canonicalizeModelInventory(input.inventory);
    assertInventoryUsesDirectModelProviderIdentity(inventory);
    const submittedAvailability = input.providerAvailability;
    const providerAvailability = canonicalizeProviderOperationalAvailability(
      submittedAvailability === undefined || submittedAvailability.length === 0 ?
        inventory.document.providers.map((provider) => ({
          providerKey: provider.key,
          status: provider.adapterKind === "direct" ? "active" : "disabled",
          health: "unknown",
          epoch: "0",
          observationRef: null,
          observedAt: null,
        })) : submittedAvailability,
      new Set(inventory.document.providers.map((provider) => provider.key)),
    );
    if (context.trustedCaller.kind !== "admin_workload")
      throw new Error("MODEL_INVENTORY_IMPORT_ADMIN_WORKLOAD_REQUIRED");
    if (context.actor.kind !== "operator" && context.actor.kind !== "workload")
      throw new Error("MODEL_INVENTORY_IMPORT_MANAGEMENT_PRINCIPAL_REQUIRED");
    const command = createModelControlCommand({
      commandId: input.importId,
      idempotencyKey: input.idempotencyKey ?? input.importId,
      requestDigest: input.requestDigest,
      operation: "model.inventory.import",
      security: modelControlSecurityFacts(context),
      effect: {
        inventoryDigest: inventory.digest,
        source: inventory.document.source,
        providerAvailability,
      },
    });
    return this.unitOfWork.execute(
      { context, operation: "model.inventory.import" },
      async (transaction) => {
        await this.journal.begin(transaction, command);
        const receipt = await this.repository.importInventory(transaction, {
          importId: input.importId,
          importedBy: context.actor.subjectId,
          inventory,
          providerAvailability,
        });
        await this.journal.succeed(transaction, command, receipt);
        return receipt;
      },
    );
  }
}
