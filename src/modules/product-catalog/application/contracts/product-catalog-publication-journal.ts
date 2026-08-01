import type { PlatformTransaction } from "../../../../shared/unit-of-work/index.js";
import type {
  ProductPublicationCommand,
  ProductPublicationReceipt,
} from "../product-publication-command.js";
import type { ImmutableRevisionBinding } from "../../domain/product-publication.js";

export interface CompletedProductPublication {
  readonly binding: ImmutableRevisionBinding;
  readonly publicationReplayed: boolean;
  readonly recordedAt: string;
}

export interface ProductCatalogPublicationJournal {
  findSucceeded(
    transaction: PlatformTransaction,
    command: ProductPublicationCommand,
  ): Promise<CompletedProductPublication | null>;
  begin(
    transaction: PlatformTransaction,
    command: ProductPublicationCommand,
  ): Promise<CompletedProductPublication | null>;
  succeed(
    transaction: PlatformTransaction,
    command: ProductPublicationCommand,
    receipt: ProductPublicationReceipt,
  ): Promise<CompletedProductPublication>;
}
