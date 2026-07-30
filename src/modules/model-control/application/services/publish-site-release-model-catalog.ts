import type { VerifiedRequestSecurityContext } from "../../../../shared/security-context/index.js";
import type { PlatformUnitOfWork } from "../../../../shared/unit-of-work/index.js";
import { createSiteReleaseModelCatalogRevision } from "../../domain/product-model-option.js";
import type { ModelControlCommandJournal } from "../contracts/model-control-command-journal.js";
import type {
  ModelOptionCatalogRepository,
  SiteReleaseModelCatalogAdministration,
  SiteReleaseModelCatalogPublishReceipt,
} from "../contracts/product-model-option-ports.js";
import {
  assertModelControlCommandId,
  createModelControlCommand,
  modelControlSecurityFacts,
} from "../model-control-command.js";

export class PublishSiteReleaseModelCatalogService
  implements SiteReleaseModelCatalogAdministration
{
  constructor(
    private readonly unitOfWork: PlatformUnitOfWork,
    private readonly repository: ModelOptionCatalogRepository,
    private readonly journal: ModelControlCommandJournal,
    private readonly options: Readonly<{ now?: () => string }> = {},
  ) {}

  publish(
    input: Parameters<SiteReleaseModelCatalogAdministration["publish"]>[0],
    context: VerifiedRequestSecurityContext,
  ): Promise<SiteReleaseModelCatalogPublishReceipt> {
    assertModelControlCommandId(input.publicationId, "MODEL_OPTION_PUBLICATION_ID_INVALID");
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
    const publishedAt = this.options.now?.() ?? new Date().toISOString();
    if (!Number.isFinite(Date.parse(publishedAt)) || new Date(publishedAt).toISOString() !== publishedAt) {
      throw new Error("MODEL_OPTION_PUBLICATION_TIME_INVALID");
    }
    return this.unitOfWork.execute(
      { context, operation: "model.site-release-catalog.publish" },
      async (transaction) => {
        const optionRevisions = await this.repository.loadOptionRevisions(
          transaction,
          revisionRefs,
        );
        const catalog = createSiteReleaseModelCatalogRevision({
          ...input,
          publishedAt,
          optionRevisions,
        });
        const command = createModelControlCommand({
          commandId: input.publicationId,
          idempotencyKey: input.idempotencyKey ?? input.publicationId,
          requestDigest: input.requestDigest,
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
        await this.journal.succeed(transaction, command, receipt);
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
    typeof receipt.replayed !== "boolean" ||
    !canonicalInstant(receipt.publishedAt) ||
    (!receipt.replayed && receipt.publishedAt !== catalog.publishedAt)
  )
    throw new Error("MODEL_OPTION_SITE_RELEASE_RECEIPT_INVALID");
}

function canonicalInstant(value: string): boolean {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
}
