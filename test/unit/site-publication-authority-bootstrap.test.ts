import { createHash, generateKeyPairSync } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalDigest } from
  "../../src/modules/product-catalog/domain/canonical-product-document.js";
import { loadSitePublicationAuthorityBootstrapDocument } from
  "../../src/process/site-publication-authority-bootstrap.js";

const directories: string[] = [];
const digestA = `sha256:${"a".repeat(64)}`;
const digestB = `sha256:${"b".repeat(64)}`;

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("Site publication authority bootstrap", () => {
  it("loads a private static authority document and derives its canonical configuration digest", async () => {
    const document = validDocument();
    const path = await privateDocument(document);

    await expect(loadSitePublicationAuthorityBootstrapDocument(path)).resolves.toEqual({
      document,
      configurationDigest: canonicalDigest(document).slice(7),
    });
  });

  it("rejects unsafe files and malformed or internally inconsistent authority", async () => {
    const unsafe = await privateDocument(validDocument());
    await chmod(unsafe, 0o640);
    await expect(loadSitePublicationAuthorityBootstrapDocument(unsafe))
      .rejects.toThrow("SITE_PUBLICATION_AUTHORITY_BOOTSTRAP_FILE_UNSAFE");

    const invalid = validDocument();
    invalid.effectiveAccess[0]!.snapshotDigest = digestB;
    const invalidPath = await privateDocument(invalid);
    await expect(loadSitePublicationAuthorityBootstrapDocument(invalidPath))
      .rejects.toThrow("SITE_PUBLICATION_AUTHORITY_BOOTSTRAP_DOCUMENT_INVALID");
  });

  it("rejects unknown fields, duplicate Site heads, and public-key fingerprint drift", async () => {
    const cases = [
      { ...validDocument(), unexpected: true },
      (() => {
        const value = validDocument();
        value.intentIssuers.push({ ...value.intentIssuers[0]! });
        return value;
      })(),
      (() => {
        const value = validDocument();
        value.producerTrust[0]!.publicKeyFingerprint = digestA;
        return value;
      })(),
    ];
    for (const value of cases) {
      const path = await privateDocument(value);
      await expect(loadSitePublicationAuthorityBootstrapDocument(path))
        .rejects.toThrow("SITE_PUBLICATION_AUTHORITY_BOOTSTRAP_DOCUMENT_INVALID");
    }
  });
});

async function privateDocument(value: unknown): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "kokoro-site-publication-authority-"));
  directories.push(directory);
  const path = join(directory, "authority.json");
  await writeFile(path, JSON.stringify(value));
  await chmod(path, 0o600);
  return path;
}

function validDocument() {
  const snapshot = {
    webBuildMaterialBundle: binding("material.main", "1", digestA),
    siteConfig: binding("site.config.main", "1", digestA),
    legalPolicy: binding("legal.policy.main", "1", digestA),
    salesPolicy: binding("sales.policy.main", "1", digestA),
    assortmentPolicy: binding("assortment.policy.main", "1", digestA),
    memoryPolicy: binding("memory.policy.main", "1", digestA),
    authIdentityClosure: {
      identityIssuer: binding("identity.issuer.main", "1", digestA),
      authenticationPolicy: binding("authentication.policy.main", "1", digestA),
      authorizationPolicy: binding("authorization.policy.main", "1", digestA),
      closureDigest: digestA,
    },
    commerceClosure: {
      offerRevisions: [binding("offer.main", "1", digestA)],
      entitlementTemplateRevisions: [binding("entitlement.main", "1", digestA)],
      creditProgramRevisions: [binding("credit.program.main", "1", digestA)],
      closureDigest: digestA,
    },
    hubClosure: {
      capabilityAssignment: binding("capability.assignment.main", "1", digestA),
      capabilityCatalog: binding("capability.catalog.main", "1", digestA),
      agentCatalog: binding("agent.catalog.main", "1", digestA),
      closureDigest: digestA,
    },
    modelRequirements: [{ modelRoleRef: "model.role.main",
      modelInventory: { ref: "model.inventory.main", digest: digestA },
      modelCatalog: { ref: "model.catalog.main", digest: digestA } }],
  };
  const authority = {
    authorityRef: "intent.authority.main", authorityRevision: "1", authorityDigest: digestA,
    siteRef: "site.alpha", environment: "production",
    webCompositionRegistry: binding("web.registry.main", "1", digestA),
    webBuildToolchain: binding("web.toolchain.main", "1", digestA),
    contractFloor: [{ contractRef: "platform.public.v1", minimumMajor: "1" }],
    issuerRef: "platform.site.intent-issuer",
    producerRegistry: { ref: "producer.registry.main", digest: digestA },
    producerRegistryEpoch: "1", trustPolicy: { ref: "trust.intent.main", digest: digestA },
    trustPolicyEpoch: "1", signingKeyId: "key.intent.main", keyVersion: "1",
    publicKeyFingerprint: digestA, keyValidFrom: "2026-07-01T00:00:00.000Z",
    keyValidUntil: "2027-07-01T00:00:00.000Z",
  };
  const { publicKey } = generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ format: "pem", type: "spki" }).toString();
  const publicKeyFingerprint = `sha256:${createHash("sha256")
    .update(publicKey.export({ format: "der", type: "spki" })).digest("hex")}`;
  const trust = (role: "web-artifact-provenance-attestor" |
  "release-certification-authority") => ({
    producerIdentityRef: role === "web-artifact-provenance-attestor"
      ? "producer.web-attestor" : "producer.release-certifier",
    producerRole: role, environment: "production",
    producerRegistration: binding(`producer.registration.${role}`, "1", digestA),
    producerRegistryEpoch: "1",
    trustPolicy: binding(`trust.policy.${role}`, "1", digestA), trustPolicyEpoch: "1",
    signingKeyId: role === "web-artifact-provenance-attestor"
      ? "key.web-attestor" : "key.release-certifier",
    signingKeyVersion: "1",
    signatureAudience: role === "web-artifact-provenance-attestor"
      ? "kokoro.web-artifact-provenance.v1" : "kokoro.site-release.activation.v1",
    keyStatus: "active" as const, keyValidFrom: "2026-07-01T00:00:00.000Z",
    keyValidUntil: "2027-07-01T00:00:00.000Z", publicKeyPem, publicKeyFingerprint,
  });
  return {
    version: 1 as const,
    effectiveAccess: [{
      siteRef: "site.alpha", environment: "production",
      launchProductProfile: binding("profile.main", "1", digestA),
      productSurfaceCatalog: binding("catalog.main", "1", digestA),
      snapshotDigest: canonicalDigest(snapshot), snapshot,
    }],
    intentIssuers: [authority],
    producerTrust: [trust("web-artifact-provenance-attestor"),
      trust("release-certification-authority")],
  };
}

function binding(ref: string, revision: string, digest: string) {
  return { ref, revision, digest };
}
