import type { VerifiedRequestSecurityContext } from "../../../../shared/security-context/index.js";
import type { PlatformUnitOfWork } from "../../../../shared/unit-of-work/index.js";
import { verifyLegacyModelOptionMigrationArtifact } from "../../migration/legacy-model-option-artifact.js";
import { materializeLegacyModelOptionArtifact } from "../../migration/legacy-model-option-materializer.js";
import type { ModelControlCommandJournal } from "../contracts/model-control-command-journal.js";
import type {
  ModelOptionCatalogRepository,
  ModelOptionMaterializationAdministration,
  ModelOptionMaterializationReceipt,
} from "../contracts/product-model-option-ports.js";
import { createModelControlCommand, modelControlSecurityFacts } from "../model-control-command.js";

export class MaterializeLegacyModelOptionsService
  implements ModelOptionMaterializationAdministration
{
  constructor(
    private readonly unitOfWork: PlatformUnitOfWork,
    private readonly repository: ModelOptionCatalogRepository,
    private readonly journal: ModelControlCommandJournal,
  ) {}

  materialize(
    input: Parameters<ModelOptionMaterializationAdministration["materialize"]>[0],
    context: VerifiedRequestSecurityContext,
  ): Promise<ModelOptionMaterializationReceipt> {
    uuid(input.materializationId, "MODEL_OPTION_MATERIALIZATION_ID_INVALID");
    const artifact = verifyLegacyModelOptionMigrationArtifact(input.artifact);
    digest(input.inventoryDigest, "MODEL_OPTION_INVENTORY_DIGEST_INVALID");
    if (
      context.trustedCaller.kind !== "admin_workload" ||
      (context.actor.kind !== "operator" && context.actor.kind !== "workload") ||
      context.target.siteId !== null ||
      context.target.purpose !== "model_control_migration"
    )
      throw new Error("MODEL_OPTION_MATERIALIZATION_ADMIN_CONTEXT_REQUIRED");
    const command = createModelControlCommand({
      commandId: input.materializationId,
      operation: "model.option.migration.materialize",
      security: modelControlSecurityFacts(context),
      effect: {
        artifactDigest: artifact.artifactDigest,
        inventoryDigest: input.inventoryDigest,
        compilerVersion: "model-option-compiler.v1",
      },
    });
    return this.unitOfWork.execute(
      { context, operation: "model.option.migration.materialize" },
      async (transaction) => {
        await this.journal.begin(transaction, command);
        const inventory = await this.repository.loadInventory(transaction, input.inventoryDigest);
        if (!inventory || inventory.digest !== input.inventoryDigest)
          throw new Error("MODEL_OPTION_INVENTORY_NOT_FOUND");
        const materialization = materializeLegacyModelOptionArtifact({ inventory, artifact });
        const receipt = await this.repository.materializeLegacyOptions(transaction, {
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
  materialization: ReturnType<typeof materializeLegacyModelOptionArtifact>,
): void {
  const expectedRefs = materialization.optionRevisions.map(
    ({ modelOptionRevisionRef }) => modelOptionRevisionRef,
  );
  if (
    receipt.materializationId !== materializationId ||
    receipt.artifactDigest !== materialization.artifactDigest ||
    receipt.inventoryDigest !== materialization.inventoryDigest ||
    receipt.materializationDigest !== materialization.materializationDigest ||
    receipt.quarantineCount !== materialization.quarantine.length ||
    receipt.optionRevisionRefs.length !== expectedRefs.length ||
    receipt.optionRevisionRefs.some((value, index) => value !== expectedRefs[index]) ||
    typeof receipt.replayed !== "boolean"
  )
    throw new Error("MODEL_OPTION_MATERIALIZATION_RECEIPT_INVALID");
}

function uuid(value: string, code: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value))
    throw new Error(code);
}

function digest(value: string, code: string): void {
  if (!/^[a-f0-9]{64}$/u.test(value)) throw new Error(code);
}
