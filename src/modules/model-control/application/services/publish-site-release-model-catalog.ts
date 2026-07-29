import type { VerifiedRequestSecurityContext } from "../../../../shared/security-context/index.js";
import type { PlatformUnitOfWork } from "../../../../shared/unit-of-work/index.js";
import { createSiteReleaseModelCatalogRevision } from "../../domain/product-model-option.js";
import type { ModelControlCommandJournal } from "../contracts/model-control-command-journal.js";
import type {
  ModelOptionCatalogRepository,
  SiteReleaseModelCatalogAdministration,
  SiteReleaseModelCatalogPublishReceipt,
} from "../contracts/product-model-option-ports.js";
import { createModelControlCommand, modelControlSecurityFacts } from "../model-control-command.js";

export class PublishSiteReleaseModelCatalogService
  implements SiteReleaseModelCatalogAdministration
{
  constructor(
    private readonly unitOfWork: PlatformUnitOfWork,
    private readonly repository: ModelOptionCatalogRepository,
    private readonly journal: ModelControlCommandJournal,
  ) {}

  publish(
    input: Parameters<SiteReleaseModelCatalogAdministration["publish"]>[0],
    context: VerifiedRequestSecurityContext,
  ): Promise<SiteReleaseModelCatalogPublishReceipt> {
    uuid(input.publicationId, "MODEL_OPTION_PUBLICATION_ID_INVALID");
    if (
      context.trustedCaller.kind !== "admin_workload" ||
      (context.actor.kind !== "operator" && context.actor.kind !== "workload") ||
      context.target.siteId !== input.siteId ||
      context.target.purpose !== "site_release" ||
      !context.target.scopes.includes("model:site-release:publish")
    )
      throw new Error("MODEL_OPTION_SITE_RELEASE_ADMIN_CONTEXT_REQUIRED");
    const revisionRefs = [
      ...new Set(input.surfaces.flatMap((surface) => surface.allowedModelOptionRevisionRefs)),
    ];
    return this.unitOfWork.execute(
      { context, operation: "model.site-release-catalog.publish" },
      async (transaction) => {
        const optionRevisions = await this.repository.loadOptionRevisions(
          transaction,
          revisionRefs,
        );
        const catalog = createSiteReleaseModelCatalogRevision({ ...input, optionRevisions });
        const command = createModelControlCommand({
          commandId: input.publicationId,
          operation: "model.site-release-catalog.publish",
          security: modelControlSecurityFacts(context),
          effect: {
            siteId: catalog.siteId,
            siteReleaseRef: catalog.siteReleaseRef,
            inventoryDigest: catalog.inventoryDigest,
            modelOptionCatalogRef: catalog.modelOptionCatalogRef,
            catalogDigest: catalog.catalogDigest,
          },
        });
        await this.journal.begin(transaction, command);
        const receipt = await this.repository.publishSiteReleaseCatalog(transaction, {
          publicationId: input.publicationId,
          publishedBy: context.actor.subjectId,
          catalog,
        });
        assertPublishReceipt(receipt, input.publicationId, catalog);
        await this.journal.succeed(transaction, command, receipt, context);
        return receipt;
      },
    );
  }
}

function assertPublishReceipt(
  receipt: SiteReleaseModelCatalogPublishReceipt,
  publicationId: string,
  catalog: ReturnType<typeof createSiteReleaseModelCatalogRevision>,
): void {
  if (
    receipt.publicationId !== publicationId ||
    receipt.siteId !== catalog.siteId ||
    receipt.siteReleaseRef !== catalog.siteReleaseRef ||
    receipt.modelOptionCatalogRef !== catalog.modelOptionCatalogRef ||
    receipt.catalogDigest !== catalog.catalogDigest ||
    typeof receipt.replayed !== "boolean"
  )
    throw new Error("MODEL_OPTION_SITE_RELEASE_RECEIPT_INVALID");
}

function uuid(value: string, code: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value))
    throw new Error(code);
}
