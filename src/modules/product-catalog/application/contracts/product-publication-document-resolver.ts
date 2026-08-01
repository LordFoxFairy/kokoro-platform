import type { ImmutableRevisionBinding } from "../../domain/product-publication.js";
import type { ResolvedCanonicalDocument } from "../../domain/canonical-product-document.js";

export type ProductPublicationDocumentKind =
  | "product-surface-catalog"
  | "launch-product-profile";

/**
 * Resolves a Root-governed immutable document. Implementations must authenticate
 * the producer and immutable object identity. The owner still revalidates bytes,
 * canonical form and digest before any state transition.
 */
export interface ProductPublicationDocumentResolver {
  resolve(input: Readonly<{
    kind: ProductPublicationDocumentKind;
    binding: ImmutableRevisionBinding;
  }>): Promise<ResolvedCanonicalDocument>;
}
