import { describe, expect, it, vi } from "vitest";
import { SitePublicationAuthorityService } from
  "../../src/modules/site/application/services/site-publication-authority-service.js";
import { SiteWebBuildIntentIssuer } from
  "../../src/modules/site/application/services/site-web-build-intent-issuer.js";
import {
  admitSitePublicationNode,
  type SitePublicationNode,
  type SiteReleaseCandidateAuthority,
} from "../../src/modules/site/domain/site-publication-authority.js";
import type { VerifiedRequestSecurityContext } from
  "../../src/shared/security-context/index.js";
import {
  SITE_WEB_BUILD_INTENT_PAYLOAD_TYPE,
  type SiteWebBuildIntentDsseEnvelope,
} from
  "../../src/modules/site/domain/site-web-build-intent-dsse.js";

const digestA = `sha256:${"a".repeat(64)}`;
const digestB = `sha256:${"b".repeat(64)}`;
const digestC = `sha256:${"c".repeat(64)}`;

describe("SitePublicationAuthorityService WebBuildIntent issuance", () => {
  it("persists one Platform-issued intent bound to the locked Candidate predecessors", async () => {
    const candidate = candidateAuthority();
    const inventory = node("surface-inventory", { shellRequirementRefs: ["shell.main"] }, {
      ref: "surface-inventory.main", revision: 7n, digest: digestB,
    }, candidate);
    const material = node("web-build-material-bundle", {}, {
      ref: "web-build-material.main", revision: 4n, digest: digestC,
    }, candidate);
    let persistedNode: SitePublicationNode | null = null;
    let persistedEnvelope: SiteWebBuildIntentDsseEnvelope | null = null;
    const inserted = vi.fn(async (_transaction: unknown, node: SitePublicationNode) => {
      persistedNode = node;
    });
    const insertedEnvelope = vi.fn(async (
      _transaction: unknown,
      _binding: unknown,
      value: SiteWebBuildIntentDsseEnvelope,
    ) => {
      persistedEnvelope = value;
    });
    const succeeded = vi.fn(async () => undefined);
    const repository = {
      loadCandidateForUpdate: vi.fn(async () => candidate),
      loadNode: vi.fn(async (_transaction: unknown, kind: string) => {
        if (kind === "surface-inventory") return inventory;
        if (kind === "web-build-material-bundle") return material;
        if (kind === "web-build-intent") return persistedNode;
        return null;
      }),
      insertNode: inserted,
      loadWebBuildIntentEnvelope: vi.fn(async () => persistedEnvelope),
      insertWebBuildIntentEnvelope: insertedEnvelope,
    };
    const signer = intentSigner();
    const journal = {
      begin: vi.fn().mockResolvedValueOnce("fresh").mockResolvedValueOnce("replay"),
      succeed: succeeded,
    };
    const service = new SitePublicationAuthorityService(
      { execute: async (_fence: unknown, work: (transaction: unknown) => Promise<unknown>) => work({}) } as never,
      repository as never,
      journal as never,
      {} as never,
      {} as never,
      new SiteWebBuildIntentIssuer(
        intentAuthority(),
        signer,
        () => "2026-08-01T00:00:00.000Z",
      ),
      {} as never,
      {} as never,
    );

    const command = {
      commandId: "018f1212-1212-7212-8212-121212121212",
      idempotencyKey: "intent-issue-alpha-0001",
      siteRef: "site.alpha",
      candidate: candidate.binding,
      expectedSurfaceInventory: inventory.binding,
      expectedWebBuildMaterialBundle: material.binding,
      reason: "issue the authorized build input",
    } as const;
    const result = await service.issueWebBuildIntent(command, context());
    const replay = await service.issueWebBuildIntent(command, context());

    expect(result).toMatchObject({ siteRef: "site.alpha", state: "published", replayed: false });
    expect(result.binding.ref).toMatch(/^web-build-intent\.[a-f0-9]{64}$/u);
    expect(result.binding.revision).toBe(7n);
    expect(inserted).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        kind: "web-build-intent",
        candidate: candidate.binding,
        binding: result.binding,
      }),
      "platform-issued",
      "018f1212-1212-7212-8212-121212121212",
    );
    expect(insertedEnvelope).toHaveBeenCalledWith(
      {},
      result.binding,
      expect.objectContaining({
        payloadType: SITE_WEB_BUILD_INTENT_PAYLOAD_TYPE,
        signatures: [expect.objectContaining({ keyid: "key.web-build-intent" })],
      }),
      "018f1212-1212-7212-8212-121212121212",
    );
    expect(replay).toEqual({ ...result, replayed: true });
    expect(signer.sign).toHaveBeenCalledOnce();
    expect(signer.verify).toHaveBeenCalledOnce();
    expect(succeeded).toHaveBeenCalledOnce();
  });

  it.each(["missing", "tampered-payload"] as const)(
    "fails closed on %s persisted envelope during replay without re-signing",
    async (failure) => {
      const candidate = candidateAuthority();
      const inventory = node("surface-inventory", { shellRequirementRefs: ["shell.main"] }, {
        ref: "surface-inventory.main", revision: 7n, digest: digestB,
      }, candidate);
      const material = node("web-build-material-bundle", {}, {
        ref: "web-build-material.main", revision: 4n, digest: digestC,
      }, candidate);
      const predecessors = {
        "surface-inventory": inventory,
        "web-build-material-bundle": material,
      } as const;
      const signer = intentSigner();
      const intents = new SiteWebBuildIntentIssuer(
        intentAuthority(), signer, () => "2026-08-01T00:00:00.000Z",
      );
      const issued = await intents.issue({} as never, {
        commandId: "018f1212-1212-7212-8212-121212121212",
        candidate,
        predecessors,
      });
      const intent = admitSitePublicationNode("web-build-intent", {
        binding: issued.binding,
        source: issued.source,
        candidate,
        predecessors,
      });
      signer.sign.mockClear();
      const persistedEnvelope = failure === "missing" ? null : {
        ...issued.envelope,
        payload: Buffer.from('{"tampered":true}', "utf8").toString("base64"),
      };
      const repository = {
        loadCandidateForUpdate: vi.fn(async () => candidate),
        loadNode: vi.fn(async (_transaction: unknown, kind: string) => {
          if (kind === "surface-inventory") return inventory;
          if (kind === "web-build-material-bundle") return material;
          if (kind === "web-build-intent") return intent;
          return null;
        }),
        loadWebBuildIntentEnvelope: vi.fn(async () => persistedEnvelope),
      };
      const service = new SitePublicationAuthorityService(
        { execute: async (_fence: unknown, work: (transaction: unknown) => Promise<unknown>) => work({}) } as never,
        repository as never,
        { begin: vi.fn(async () => "replay") } as never,
        {} as never,
        {} as never,
      intents,
      {} as never,
      {} as never,
      );

      await expect(service.issueWebBuildIntent({
        commandId: "018f1212-1212-7212-8212-121212121212",
        idempotencyKey: "intent-issue-alpha-0001",
        siteRef: "site.alpha",
        candidate: candidate.binding,
        expectedSurfaceInventory: inventory.binding,
        expectedWebBuildMaterialBundle: material.binding,
        reason: "issue the authorized build input",
      }, context())).rejects.toThrow(failure === "missing"
        ? "SITE_WEB_BUILD_INTENT_ENVELOPE_NOT_FOUND"
        : "SITE_WEB_BUILD_INTENT_ENVELOPE_PAYLOAD_MISMATCH");
      expect(signer.sign).not.toHaveBeenCalled();
      expect(signer.verify).not.toHaveBeenCalled();
    },
  );
});

function intentAuthority() {
  const value = {
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
  return {
    resolve: vi.fn(async () => value),
    resolveExact: vi.fn(async () => value),
  };
}

function intentSigner() {
  return {
    sign: vi.fn(async (input: Readonly<{ payload: Uint8Array }>) => ({
      payloadType: SITE_WEB_BUILD_INTENT_PAYLOAD_TYPE,
      payload: Buffer.from(input.payload).toString("base64"),
      signatures: [{
        keyid: "key.web-build-intent",
        sig: Buffer.alloc(64, 1).toString("base64"),
      }],
    }) as const),
    verify: vi.fn(async () => undefined),
  };
}

function candidateAuthority(): SiteReleaseCandidateAuthority {
  return Object.freeze({
    binding: Object.freeze({
      ref: "candidate.alpha", version: 7n, authorizationEpoch: 3n, digest: digestA,
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
        webBuildMaterialBundle: binding("web-build-material.main", "4", digestC),
        siteConfig: binding("site-config.main", "1", digestA),
        legalPolicy: binding("legal-policy.main", "1", digestA),
        salesPolicy: binding("sales-policy.main", "1", digestA),
        assortmentPolicy: binding("assortment-policy.main", "1", digestA),
        memoryPolicy: binding("memory-policy.main", "1", digestA),
        authIdentityClosure: Object.freeze({
          identityIssuer: binding("identity-issuer.main", "1", digestA),
          authenticationPolicy: binding("authentication-policy.main", "1", digestA),
          authorizationPolicy: binding("authorization-policy.main", "1", digestA),
          closureDigest: digestA,
        }),
        commerceClosure: Object.freeze({
          offerRevisions: Object.freeze([binding("offer.main", "1", digestA)]),
          entitlementTemplateRevisions: Object.freeze([binding("entitlement.main", "1", digestA)]),
          creditProgramRevisions: Object.freeze([binding("credit-program.main", "1", digestA)]),
          closureDigest: digestA,
        }),
        hubClosure: Object.freeze({
          capabilityAssignment: binding("capability-assignment.main", "1", digestA),
          capabilityCatalog: binding("capability-catalog.main", "1", digestA),
          agentCatalog: binding("agent-catalog.main", "1", digestA),
          closureDigest: digestA,
        }),
      }),
    }),
    canonicalBytes: new Uint8Array([123, 125]),
  });
}

function node(
  kind: SitePublicationNode["kind"],
  document: SitePublicationNode["document"],
  revision: SitePublicationNode["binding"],
  candidate: SiteReleaseCandidateAuthority,
): SitePublicationNode {
  return Object.freeze({
    kind,
    binding: Object.freeze(revision),
    candidate: candidate.binding,
    siteRef: candidate.siteRef,
    document,
    canonicalBytes: new Uint8Array([123, 125]),
  });
}

function binding(ref: string, revision: string, digest: string) {
  return Object.freeze({ ref, revision, digest });
}

function context(): VerifiedRequestSecurityContext {
  return Object.freeze({
    requestId: "request:1",
    correlationId: "correlation:1",
    trustedCaller: Object.freeze({ kind: "admin_workload", workloadIdentityId: "admin:1" }),
    actor: Object.freeze({ kind: "operator", subjectId: "operator:1" }),
    target: Object.freeze({ siteId: "site.alpha" }),
    environment: "production",
    region: "us-east-1",
  }) as VerifiedRequestSecurityContext;
}
