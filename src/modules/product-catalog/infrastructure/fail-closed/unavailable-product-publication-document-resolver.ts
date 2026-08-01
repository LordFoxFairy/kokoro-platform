import type { ProductPublicationDocumentResolver } from
  "../../application/contracts/product-publication-document-resolver.js";

/** Production default until Root provides an authenticated immutable bundle source. */
export class UnavailableProductPublicationDocumentResolver
  implements ProductPublicationDocumentResolver {
  resolve(): Promise<never> {
    return Promise.reject(new Error("PRODUCT_PUBLICATION_DOCUMENT_SOURCE_UNAVAILABLE"));
  }
}
