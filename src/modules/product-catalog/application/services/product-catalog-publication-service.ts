import type { VerifiedRequestSecurityContext } from "../../../../shared/security-context/index.js";
import type { PlatformUnitOfWork } from "../../../../shared/unit-of-work/index.js";
import type { ProductCatalogPublicationJournal } from "../contracts/product-catalog-publication-journal.js";
import type { CompletedProductPublication } from "../contracts/product-catalog-publication-journal.js";
import type { ProductCatalogPublicationRepository } from "../contracts/product-catalog-publication-repository.js";
import type { ProductPublicationDocumentResolver } from "../contracts/product-publication-document-resolver.js";
import {
  createProductPublicationCommand,
  type ProductPublicationReceipt,
} from "../product-publication-command.js";
import {
  decideCatalogPublication,
  decideProfilePublication,
  resolveLaunchProductProfileRevision,
  resolveProductSurfaceCatalogRevision,
  validateLaunchProductProfileClosure,
  type ImmutableRevisionBinding,
} from "../../domain/product-publication.js";

export interface ProductCatalogPublicationAdministration {
  publishCatalog(input: ProductCatalogPublishInput, context: VerifiedRequestSecurityContext):
    Promise<ProductPublicationResult>;
  publishProfile(input: LaunchProductProfilePublishInput, context: VerifiedRequestSecurityContext):
    Promise<ProductPublicationResult>;
}

interface PublicationCommandInput {
  readonly commandId: string;
  readonly idempotencyKey?: string;
  readonly requestDigest: string;
  readonly expectedHeadRevision: bigint;
  readonly reason: string;
}

export interface ProductCatalogPublishInput extends PublicationCommandInput {
  readonly binding: ImmutableRevisionBinding;
}

export interface LaunchProductProfilePublishInput extends PublicationCommandInput {
  readonly binding: ImmutableRevisionBinding;
  readonly catalogBinding: ImmutableRevisionBinding;
}

export interface ProductPublicationResult extends ProductPublicationReceipt {
  readonly recordedAt: string;
  readonly commandReplayed: boolean;
  readonly publicationReplayed: boolean;
}

export class ProductCatalogPublicationService implements ProductCatalogPublicationAdministration {
  constructor(
    private readonly unitOfWork: PlatformUnitOfWork,
    private readonly repository: ProductCatalogPublicationRepository,
    private readonly journal: ProductCatalogPublicationJournal,
    private readonly documents: ProductPublicationDocumentResolver,
  ) {}

  async publishCatalog(
    input: ProductCatalogPublishInput,
    context: VerifiedRequestSecurityContext,
  ): Promise<ProductPublicationResult> {
    const command = createProductPublicationCommand({ ...input, operation: "product.catalog.publish" }, context);
    const replay = await this.completed(command, context);
    if (replay !== null) return replayResult(replay);
    const source = await this.documents.resolve({ kind: "product-surface-catalog", binding: input.binding });
    const candidate = resolveProductSurfaceCatalogRevision(input.binding, source);
    return this.unitOfWork.execute({ context, operation: command.operation }, async (transaction) => {
      const completed = await this.journal.begin(transaction, command);
      if (completed !== null) return replayResult(completed);
      const snapshot = await this.repository.loadCatalogStateForUpdate(transaction, candidate.binding);
      const decision = decideCatalogPublication(candidate, input.expectedHeadRevision, snapshot);
      const audit = auditFacts(command, decision.kind === "replay");
      if (decision.kind === "publish") await this.repository.persistCatalog(transaction, candidate, audit);
      else await this.repository.recordReplay(transaction, candidate.binding, null, audit);
      const publicationReplayed = decision.kind === "replay";
      const receipt = Object.freeze({ binding: decision.revision.binding, replayed: publicationReplayed });
      const persisted = await this.journal.succeed(transaction, command, receipt);
      return Object.freeze({ ...receipt, recordedAt: persisted.recordedAt,
        commandReplayed: false, publicationReplayed });
    });
  }

  async publishProfile(
    input: LaunchProductProfilePublishInput,
    context: VerifiedRequestSecurityContext,
  ): Promise<ProductPublicationResult> {
    const command = createProductPublicationCommand({
      ...input,
      operation: "product.launch-profile.publish",
      catalogBinding: input.catalogBinding,
    }, context);
    const replay = await this.completed(command, context);
    if (replay !== null) return replayResult(replay);
    const source = await this.documents.resolve({ kind: "launch-product-profile", binding: input.binding });
    const candidate = resolveLaunchProductProfileRevision(input.binding, input.catalogBinding, source);
    if (!sameBinding(candidate.productSurfaceCatalog, input.catalogBinding)) {
      throw new Error("LAUNCH_PRODUCT_PROFILE_EFFECT_CATALOG_MISMATCH");
    }
    return this.unitOfWork.execute({ context, operation: command.operation }, async (transaction) => {
      const completed = await this.journal.begin(transaction, command);
      if (completed !== null) return replayResult(completed);
      const catalog = await this.repository.loadPublishedCatalog(transaction, input.catalogBinding);
      if (catalog === null) throw new Error("LAUNCH_PRODUCT_PROFILE_CATALOG_NOT_FOUND");
      validateLaunchProductProfileClosure(candidate, catalog);
      const snapshot = await this.repository.loadProfileStateForUpdate(transaction, candidate.binding);
      const decision = decideProfilePublication(candidate, input.expectedHeadRevision, snapshot);
      const audit = auditFacts(command, decision.kind === "replay");
      if (decision.kind === "publish") await this.repository.persistProfile(transaction, candidate, audit);
      else await this.repository.recordReplay(transaction, candidate.binding, input.catalogBinding, audit);
      const publicationReplayed = decision.kind === "replay";
      const receipt = Object.freeze({ binding: decision.revision.binding, replayed: publicationReplayed });
      const persisted = await this.journal.succeed(transaction, command, receipt);
      return Object.freeze({ ...receipt, recordedAt: persisted.recordedAt,
        commandReplayed: false, publicationReplayed });
    });
  }

  private completed(
    command: ReturnType<typeof createProductPublicationCommand>,
    context: VerifiedRequestSecurityContext,
  ): Promise<CompletedProductPublication | null> {
    return this.unitOfWork.execute({ context, operation: command.operation },
      (transaction) => this.journal.findSucceeded(transaction, command));
  }
}

function auditFacts(command: ReturnType<typeof createProductPublicationCommand>, replayed: boolean) {
  return Object.freeze({
    commandId: command.commandId,
    operation: command.operation,
    reason: command.reason,
    actorSubjectId: command.security.actorSubjectId,
    environment: command.security.environment,
    region: command.security.region,
    expectedHeadRevision: command.expectedHeadRevision,
    replayed,
  });
}

function sameBinding(left: ImmutableRevisionBinding, right: ImmutableRevisionBinding): boolean {
  return left.ref === right.ref && left.revision === right.revision && left.digest === right.digest;
}

function replayResult(completed: CompletedProductPublication): ProductPublicationResult {
  return Object.freeze({
    binding: completed.binding,
    replayed: true,
    commandReplayed: true,
    publicationReplayed: completed.publicationReplayed,
    recordedAt: completed.recordedAt,
  });
}
