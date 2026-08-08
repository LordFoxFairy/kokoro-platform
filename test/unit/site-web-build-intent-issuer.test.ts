import { describe, expect, it, vi } from "vitest";
import { SiteWebBuildIntentIssuer } from
  "../../src/modules/site/application/services/site-web-build-intent-issuer.js";
import type {
  SitePublicationNode,
  SiteReleaseCandidateAuthority,
} from "../../src/modules/site/domain/site-publication-authority.js";
import { SITE_WEB_BUILD_INTENT_PAYLOAD_TYPE } from
  "../../src/modules/site/domain/site-web-build-intent-dsse.js";

const digestA = `sha256:${"a".repeat(64)}`;
const digestB = `sha256:${"b".repeat(64)}`;
const digestC = `sha256:${"c".repeat(64)}`;

describe("SiteWebBuildIntentIssuer", () => {
  it("derives the immutable intent identity and digest from Platform authority", async () => {
    const resolvedAuthority = {
      webCompositionRegistry: { ref: "web-composition-registry.main", revision: 5n, digest: digestA },
      webBuildToolchain: { ref: "web-build-toolchain.main", revision: 9n, digest: digestB },
      contractFloor: [{ contractRef: "platform-public.v1", minimumMajor: 1n }],
      issuerRef: "platform.site-signer",
      producerRegistry: { ref: "trusted-producer-registry.production", digest: digestA },
      producerRegistryEpoch: 4n,
      trustPolicy: { ref: "trust-policy.web-build-intent", digest: digestB },
      trustPolicyEpoch: 9n,
      signingKeyId: "key.web-build-intent",
      keyVersion: 3n,
      publicKeyFingerprint: digestC,
      keyValidFrom: "2026-07-01T00:00:00.000Z",
      keyValidUntil: "2026-09-01T00:00:00.000Z",
    };
    const authority = {
      resolve: vi.fn(async () => resolvedAuthority),
      resolveExact: vi.fn(async () => resolvedAuthority),
    };
    const signer = {
      sign: vi.fn(async (input: Readonly<{ payload: Uint8Array }>) => ({
        payloadType: SITE_WEB_BUILD_INTENT_PAYLOAD_TYPE,
        payload: Buffer.from(input.payload).toString("base64"),
        signatures: [{ keyid: "key.web-build-intent", sig: Buffer.alloc(64, 1).toString("base64") }],
      }) as const),
      verify: vi.fn(async () => undefined),
    };
    const issuer = new SiteWebBuildIntentIssuer(
      authority,
      signer,
      () => "2026-08-01T00:00:00.000Z",
    );
    const input = {
      commandId: "018f1212-1212-7212-8212-121212121212",
      candidate: candidate(),
      predecessors: predecessors(),
    };

    const first = await issuer.issue({} as never, input as never);
    const replay = await issuer.issue({} as never, input as never);
    const otherCommand = await issuer.issue({} as never, {
      ...input,
      commandId: "018f1212-1212-7212-8212-121212121213",
    } as never);

    expect(first.binding.ref).toMatch(/^web-build-intent\.[a-f0-9]{64}$/u);
    expect(first.binding.revision).toBe(7n);
    expect(first.binding.digest).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(first.source.digest).toBe(first.binding.digest);
    expect(first.source.parsedDocument).toMatchObject({
      contract: "kokoro.web-build-intent.v1",
      intentRef: first.binding.ref,
      revision: "7",
      siteRef: "site.alpha",
      issuedAt: "2026-08-01T00:00:00.000Z",
    });
    expect(first.envelope).toEqual({
      payloadType: SITE_WEB_BUILD_INTENT_PAYLOAD_TYPE,
      payload: Buffer.from(first.source.canonicalBytes).toString("base64"),
      signatures: [{ keyid: "key.web-build-intent", sig: Buffer.alloc(64, 1).toString("base64") }],
    });
    expect(signer.sign).toHaveBeenCalledTimes(3);
    expect(replay).toEqual(first);
    expect(otherCommand.binding.ref).not.toBe(first.binding.ref);
    await expect(issuer.verify({} as never, {
      candidate: input.candidate,
      node: {
        kind: "web-build-intent",
        binding: first.binding,
        candidate: input.candidate.binding,
        siteRef: input.candidate.siteRef,
        document: first.source.parsedDocument,
        canonicalBytes: first.source.canonicalBytes,
      },
      envelope: first.envelope,
    } as never)).resolves.toBeUndefined();
    expect(authority.resolveExact).toHaveBeenCalledWith({}, {
      siteRef: "site.alpha",
      environment: "production",
      key: {
        keyId: "key.web-build-intent",
        keyVersion: 3n,
        publicKeyFingerprint: digestC,
      },
    });
    expect(signer.verify).toHaveBeenCalledOnce();
  });
});

function candidate(): SiteReleaseCandidateAuthority {
  return Object.freeze({
    binding: Object.freeze({
      ref: "candidate.alpha",
      version: 7n,
      authorizationEpoch: 3n,
      digest: digestA,
    }),
    siteRef: "site.alpha",
    environment: "production",
    launchProductProfile: Object.freeze({ ref: "profile.main", revision: 2n, digest: digestB }),
    productSurfaceCatalog: Object.freeze({ ref: "catalog.main", revision: 4n, digest: digestC }),
    businessBindingsDigest: digestA,
    state: "authorized",
    document: Object.freeze({
      modelRequirements: Object.freeze([]),
      businessBindings: Object.freeze({
        webBuildMaterialBundle: binding("web-build-material.main", digestC),
        siteConfig: binding("site-config.main", digestA),
        legalPolicy: binding("legal-policy.main", digestA),
        salesPolicy: binding("sales-policy.main", digestA),
        assortmentPolicy: binding("assortment-policy.main", digestA),
        memoryPolicy: binding("memory-policy.main", digestA),
        authIdentityClosure: Object.freeze({
          identityIssuer: binding("identity-issuer.main", digestA),
          authenticationPolicy: binding("authentication-policy.main", digestA),
          authorizationPolicy: binding("authorization-policy.main", digestA),
          closureDigest: digestA,
        }),
        commerceClosure: Object.freeze({
          offerRevisions: Object.freeze([binding("offer.main", digestA)]),
          entitlementTemplateRevisions: Object.freeze([binding("entitlement.main", digestA)]),
          creditProgramRevisions: Object.freeze([binding("credit-program.main", digestA)]),
          closureDigest: digestA,
        }),
        hubClosure: Object.freeze({
          capabilityAssignment: binding("capability-assignment.main", digestA),
          capabilityCatalog: binding("capability-catalog.main", digestA),
          agentCatalog: binding("agent-catalog.main", digestA),
          closureDigest: digestA,
        }),
      }),
    }),
    canonicalBytes: new Uint8Array([123, 125]),
  });
}

function binding(ref: string, digest: string) {
  return Object.freeze({ ref, revision: "1", digest });
}

function predecessors() {
  return Object.freeze({
    "surface-inventory": node("surface-inventory", {
      shellRequirementRefs: Object.freeze(["shell.main"]),
    }, { ref: "surface-inventory.main", revision: 7n, digest: digestB }),
    "web-build-material-bundle": node("web-build-material-bundle", {}, {
      ref: "web-build-material.main",
      revision: 4n,
      digest: digestC,
    }),
  });
}

function node(
  kind: SitePublicationNode["kind"],
  document: SitePublicationNode["document"],
  binding: SitePublicationNode["binding"],
): SitePublicationNode {
  return Object.freeze({
    kind,
    binding: Object.freeze(binding),
    candidate: candidate().binding,
    siteRef: "site.alpha",
    document,
    canonicalBytes: new Uint8Array([123, 125]),
  });
}
