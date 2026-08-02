import type {
  ProductPublicationDocumentKind,
  ProductPublicationDocumentResolver,
} from "../../application/contracts/product-publication-document-resolver.js";
import { ContentAddressedCanonicalDocumentStore } from
  "../../../../shared/supply-chain/content-addressed-canonical-document-store.js";

/**
 * Reads a release-pipeline mounted, content-addressed publication registry.
 * File names are derived exclusively from the verified SHA-256 binding; refs
 * never participate in paths. The mount is data only and must be read-only in
 * production.
 */
export class ContentAddressedProductPublicationDocumentResolver
implements ProductPublicationDocumentResolver {
  readonly #store: ContentAddressedCanonicalDocumentStore;

  constructor(root: string, options: Readonly<{ maximumBytes?: number }> = {}) {
    this.#store = new ContentAddressedCanonicalDocumentStore(root, options);
  }

  async resolve(input: Parameters<ProductPublicationDocumentResolver["resolve"]>[0]) {
    try {
      return await this.#store.read(input.binding.digest, expectedContract(input.kind));
    } catch (cause) {
      throw productError(cause);
    }
  }
}

function expectedContract(kind: ProductPublicationDocumentKind): string {
  return kind === "product-surface-catalog"
    ? "kokoro.product-surface-catalog.v1"
    : "kokoro.launch-product-profile.v1";
}

function productError(value: unknown): Error {
  if (!(value instanceof Error) || !value.message.startsWith("PUBLICATION_DOCUMENT_")) {
    return value instanceof Error ? value : new Error("PRODUCT_PUBLICATION_DOCUMENT_READ_FAILED");
  }
  return new Error(`PRODUCT_${value.message}`);
}
