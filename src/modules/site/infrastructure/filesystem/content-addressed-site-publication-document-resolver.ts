import type { SitePublicationDocumentResolver } from
  "../../application/contracts/site-publication-authority-ports.js";
import { ContentAddressedCanonicalDocumentStore } from
  "../../../../shared/supply-chain/content-addressed-canonical-document-store.js";

export class ContentAddressedSitePublicationDocumentResolver
implements SitePublicationDocumentResolver {
  readonly #store: ContentAddressedCanonicalDocumentStore;
  constructor(root: string, options: Readonly<{ maximumBytes?: number }> = {}) {
    this.#store = new ContentAddressedCanonicalDocumentStore(root, options);
  }
  resolve(input: Parameters<SitePublicationDocumentResolver["resolve"]>[0]) {
    const contract = ({
      "surface-inventory": "kokoro.surface-inventory.v1",
      "web-build-material-bundle": "kokoro.web-build-material-bundle.v1",
      "web-build-intent": "kokoro.web-build-intent.v1",
      "release-evidence": "kokoro.site-release-evidence.v1",
      "release-certification": "kokoro.release-certification-instance.v1",
      "compiled-web-manifest": "kokoro.compiled-web-manifest.v1",
      "web-artifact-provenance": "https://in-toto.io/Statement/v1",
    } as const)[input.kind];
    return this.#store.read(input.binding.digest, input.kind === "web-artifact-provenance"
      ? { field: "_type", value: contract }
      : contract);
  }
}
