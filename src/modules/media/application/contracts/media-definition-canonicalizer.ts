import type { CanonicalMediaRequest } from "../../domain/canonical-media-request.js";
import type { OperationDefinitionRevisionRef } from "../../domain/references.js";

/** Outbound port implemented by the Root-generated canonicalization adapter. */
export interface MediaDefinitionCanonicalizer<Request> {
  canonicalize(input: Readonly<{
    definitionRevisionRef: OperationDefinitionRevisionRef;
    request: Request;
  }>): CanonicalMediaRequest;
}
