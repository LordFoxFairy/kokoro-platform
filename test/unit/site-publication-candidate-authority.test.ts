import { describe, expect, it } from "vitest";
import { canonicalDigest, canonicalJson } from
  "../../src/modules/product-catalog/domain/canonical-product-document.js";
import {
  admitSitePublicationNode,
  authorizeSiteReleaseCandidate,
  type CandidateAuthorityBinding,
  type SiteReleaseCandidateAuthority,
} from "../../src/modules/site/domain/site-publication-authority.js";

const digestA = `sha256:${"a".repeat(64)}`;
const digestB = `sha256:${"b".repeat(64)}`;
const profile = { ref: "profile.core", revision: 1n, digest: digestA };
const catalog = { ref: "catalog.main", revision: 2n, digest: digestB };

describe("Site publication candidate authority", () => {
  it("authorizes only an owner-assembled candidate with exact business closure digest", () => {
    const document = candidateDocument();
    const result = authorizeSiteReleaseCandidate({
      siteRef: "site.alpha", environment: "production", candidateRef: "candidate.alpha",
      expectedCandidateVersion: 1n, candidateAuthorizationEpoch: 3n,
      launchProductProfile: profile, productSurfaceCatalog: catalog,
      businessBindingsDigest: canonicalDigest(document.businessBindings),
    }, source(document));

    expect(result.binding).toEqual({
      ref: "candidate.alpha", version: 1n, authorizationEpoch: 3n,
      digest: canonicalDigest(document),
    });
    expect(result.state).toBe("authorized");
  });

  it("rejects caller digest drift and cross-Site candidate substitution", () => {
    const document = candidateDocument();
    expect(() => authorizeSiteReleaseCandidate({
      siteRef: "site.beta", environment: "production", candidateRef: "candidate.alpha",
      expectedCandidateVersion: 1n, candidateAuthorizationEpoch: 3n,
      launchProductProfile: profile, productSurfaceCatalog: catalog,
      businessBindingsDigest: canonicalDigest(document.businessBindings),
    }, source(document))).toThrow("SITE_PUBLICATION_CANDIDATE_SCOPE_MISMATCH");
  });

  it("accepts a node only when it locks the exact active candidate and predecessor DAG", () => {
    const candidate = authorizedCandidate();
    const inventory = {
      contract: "kokoro.surface-inventory.v1", schemaRevision: "1",
      inventoryRevisionRef: "inventory.alpha", revision: "1", siteRef: "site.alpha",
      siteReleaseCandidate: wire(candidate.binding),
      launchProductProfile: wireRevision(profile), productSurfaceCatalog: wireRevision(catalog),
      compilerRevisionRef: "compiler.inventory-1", enabledSurfaceRefs: ["surface.chat"],
      disabledSurfaceRefs: ["surface.music"], shellRequirementRefs: ["shell.base"],
      generatedAt: "2026-08-01T00:00:00.000Z",
    };
    const admitted = admitSitePublicationNode("surface-inventory", {
      binding: { ref: "inventory.alpha", revision: 1n, digest: canonicalDigest(inventory) },
      source: source(inventory), candidate, predecessors: {},
    });
    expect(admitted.kind).toBe("surface-inventory");

    const drift = { ...inventory, siteReleaseCandidate: { ...wire(candidate.binding), authorizationEpoch: "4" } };
    expect(() => admitSitePublicationNode("surface-inventory", {
      binding: { ref: "inventory.alpha", revision: 1n, digest: canonicalDigest(drift) },
      source: source(drift), candidate, predecessors: {},
    })).toThrow("SITE_PUBLICATION_CANDIDATE_BINDING_MISMATCH");
  });
});

function candidateDocument() {
  return {
    contract: "kokoro.site-release-candidate.v1", schemaRevision: "1",
    candidateRef: "candidate.alpha", revision: "1", state: "authorized",
    siteRef: "site.alpha", environment: "production", candidateAuthorizationEpoch: "3",
    launchProductProfile: wireRevision(profile), productSurfaceCatalog: wireRevision(catalog),
    businessBindings: {
      webBuildMaterialBundle: { ref: "material.alpha", revision: "1", digest: digestA },
      siteConfig: { ref: "site-config.alpha", revision: "1", digest: digestA },
      legalPolicy: { ref: "legal.alpha", revision: "1", digest: digestA },
      salesPolicy: { ref: "sales.alpha", revision: "1", digest: digestA },
      assortmentPolicy: { ref: "assortment.alpha", revision: "1", digest: digestA },
      memoryPolicy: { ref: "memory.alpha", revision: "1", digest: digestA },
      authIdentityClosure: {
        identityIssuer: { ref: "identity-issuer.alpha", revision: "1", digest: digestA },
        authenticationPolicy: { ref: "authentication-policy.alpha", revision: "1", digest: digestA },
        authorizationPolicy: { ref: "authorization-policy.alpha", revision: "1", digest: digestA },
        closureDigest: digestA,
      },
      commerceClosure: {
        offerRevisions: [{ ref: "offer.alpha", revision: "1", digest: digestA }],
        entitlementTemplateRevisions: [{ ref: "entitlement.alpha", revision: "1", digest: digestA }],
        creditProgramRevisions: [{ ref: "credit-program.alpha", revision: "1", digest: digestA }],
        closureDigest: digestA,
      },
      hubClosure: {
        capabilityAssignment: { ref: "capability-assignment.alpha", revision: "1", digest: digestA },
        capabilityCatalog: { ref: "capability-catalog.alpha", revision: "1", digest: digestA },
        agentCatalog: { ref: "agent-catalog.alpha", revision: "1", digest: digestA },
        closureDigest: digestA,
      },
    },
    modelRequirements: [], createdAt: "2026-08-01T00:00:00.000Z",
  };
}

function authorizedCandidate(): SiteReleaseCandidateAuthority {
  const document = candidateDocument();
  return authorizeSiteReleaseCandidate({
    siteRef: document.siteRef, environment: document.environment,
    candidateRef: document.candidateRef, expectedCandidateVersion: 1n,
    candidateAuthorizationEpoch: 3n, launchProductProfile: profile,
    productSurfaceCatalog: catalog, businessBindingsDigest: canonicalDigest(document.businessBindings),
  }, source(document));
}

function source(document: unknown) {
  const bytes = Buffer.from(canonicalJson(document));
  return { canonicalBytes: bytes, parsedDocument: document, digest: canonicalDigest(document) };
}
function wire(binding: CandidateAuthorityBinding) {
  return { ref: binding.ref, version: binding.version.toString(),
    authorizationEpoch: binding.authorizationEpoch.toString(), digest: binding.digest };
}
function wireRevision(binding: { ref: string; revision: bigint; digest: string }) {
  return { ref: binding.ref, revision: binding.revision.toString(), digest: binding.digest };
}
