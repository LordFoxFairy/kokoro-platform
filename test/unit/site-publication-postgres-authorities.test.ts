import { describe, expect, it } from "vitest";
import { PostgresSiteEffectiveAccessSnapshotAuthority } from
  "../../src/modules/site/infrastructure/postgres/site-effective-access-snapshot-authority.js";
import { PostgresSiteReleaseCertificationTrustAuthority } from
  "../../src/modules/site/infrastructure/postgres/site-release-certification-trust-authority.js";
import { PostgresSiteReleaseEvidenceTrustAuthority } from
  "../../src/modules/site/infrastructure/postgres/site-release-evidence-trust-authority.js";
import { PostgresSiteWebBuildIntentIssuerAuthority } from
  "../../src/modules/site/infrastructure/postgres/site-web-build-intent-issuer-authority.js";
import { PostgresSitePublicationAuthorityRepository } from
  "../../src/modules/site/infrastructure/postgres/site-publication-authority-repository.js";
import { SITE_WEB_BUILD_INTENT_PAYLOAD_TYPE } from
  "../../src/modules/site/domain/site-web-build-intent-dsse.js";
import {
  issuePlatformTransaction,
  revokePlatformTransaction,
  type PlatformSqlTransaction,
} from "../../src/shared/unit-of-work/platform-transaction.js";

const digestA = `sha256:${"a".repeat(64)}`;
const digestB = `sha256:${"b".repeat(64)}`;
const digestC = `sha256:${"c".repeat(64)}`;
const publicKeyPem = "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA6e/s2+ossuKU1vHzn9K0r1GN2CXmcEICx251YWWjKlY=\n-----END PUBLIC KEY-----\n";

class ReadSql implements PlatformSqlTransaction {
  readonly statements: string[] = [];
  readonly values: (readonly unknown[])[] = [];
  constructor(private readonly batches: readonly (readonly Record<string, unknown>[])[]) {}
  async query<Row extends Record<string, unknown>>(
    statement: string,
    values: readonly unknown[] = [],
  ): Promise<readonly Row[]> {
    this.statements.push(statement);
    this.values.push(values);
    return (this.batches[this.statements.length - 1] ?? []) as readonly Row[];
  }
  async execute(): Promise<number> { throw new Error("read only"); }
}

class CaptureSql implements PlatformSqlTransaction {
  readonly statements: string[] = [];
  readonly values: (readonly unknown[])[] = [];
  constructor(private readonly rows: readonly Record<string, unknown>[] = []) {}
  async query<Row extends Record<string, unknown>>(
    statement: string,
    values: readonly unknown[] = [],
  ): Promise<readonly Row[]> {
    this.statements.push(statement);
    this.values.push(values);
    return this.rows as readonly Row[];
  }
  async execute(statement: string, values: readonly unknown[] = []): Promise<number> {
    this.statements.push(statement);
    this.values.push(values);
    return 1;
  }
}

describe("PostgreSQL Site publication authorities", () => {
  it("resolves one exact EffectiveAccess owner projection in the caller transaction", async () => {
    const snapshot = effectiveAccessSnapshot();
    const sql = new ReadSql([[{ snapshot }]]);
    const lease = issuePlatformTransaction(sql);
    try {
      const result = await new PostgresSiteEffectiveAccessSnapshotAuthority().resolve(
        lease.transaction,
        {
          siteRef: "site.alpha",
          environment: "production",
          launchProductProfile: binding("profile.main", 2n, digestA),
          productSurfaceCatalog: binding("catalog.main", 4n, digestB),
        },
      );

      expect(result).toEqual(expectedEffectiveAccess());
      expect(Object.isFrozen(result)).toBe(true);
      expect(sql.statements[0]).toContain("platform.site_effective_access_authority_revision");
      expect(sql.statements[0]).not.toMatch(/\bFOR (?:SHARE|UPDATE)\b/u);
      expect(sql.values[0]).toEqual([
        "site.alpha", "production", "profile.main", "2", digestA,
        "catalog.main", "4", digestB,
      ]);
    } finally {
      revokePlatformTransaction(lease);
    }
  });

  it("fails closed for missing, duplicate, or malformed EffectiveAccess authority", async () => {
    for (const rows of [[], [{ snapshot: effectiveAccessSnapshot() },
      { snapshot: effectiveAccessSnapshot() }], [{ snapshot: { unexpected: true } }]]) {
      const lease = issuePlatformTransaction(new ReadSql([rows]));
      try {
        await expect(new PostgresSiteEffectiveAccessSnapshotAuthority().resolve(
          lease.transaction,
          {
            siteRef: "site.alpha", environment: "production",
            launchProductProfile: binding("profile.main", 2n, digestA),
            productSurfaceCatalog: binding("catalog.main", 4n, digestB),
          },
        )).rejects.toThrow(/SITE_EFFECTIVE_ACCESS_AUTHORITY_/u);
      } finally {
        revokePlatformTransaction(lease);
      }
    }
  });

  it("resolves the active WebBuildIntent issuer head without environment defaults", async () => {
    const row = { webCompositionRegistryRef: "web.registry.main",
      webCompositionRegistryRevision: "5", webCompositionRegistryDigest: digestA,
      webBuildToolchainRef: "web.toolchain.main", webBuildToolchainRevision: "9",
      webBuildToolchainDigest: digestB,
      contractFloor: [{ contractRef: "platform.public.v1", minimumMajor: "1" }],
      issuerRef: "platform.site.intent-issuer", producerRegistryRef: "producer.registry.main",
      producerRegistryDigest: digestA, producerRegistryEpoch: "4",
      trustPolicyRef: "trust.intent.main", trustPolicyDigest: digestB, trustPolicyEpoch: "9",
      signingKeyId: "key.intent.main", keyVersion: "3", publicKeyFingerprint: digestC,
      keyValidFrom: "2026-07-01T00:00:00.000Z", keyValidUntil: "2026-09-01T00:00:00.000Z",
    };
    const sql = new ReadSql([[row], [row]]);
    const lease = issuePlatformTransaction(sql);
    try {
      await expect(new PostgresSiteWebBuildIntentIssuerAuthority().resolve(lease.transaction, {
        siteRef: "site.alpha", environment: "production",
      })).resolves.toEqual({
        webCompositionRegistry: { ref: "web.registry.main", revision: 5n, digest: digestA },
        webBuildToolchain: { ref: "web.toolchain.main", revision: 9n, digest: digestB },
        contractFloor: [{ contractRef: "platform.public.v1", minimumMajor: 1n }],
        issuerRef: "platform.site.intent-issuer",
        producerRegistry: { ref: "producer.registry.main", digest: digestA },
        producerRegistryEpoch: 4n,
        trustPolicy: { ref: "trust.intent.main", digest: digestB },
        trustPolicyEpoch: 9n,
        signingKeyId: "key.intent.main", keyVersion: 3n, publicKeyFingerprint: digestC,
        keyValidFrom: "2026-07-01T00:00:00.000Z", keyValidUntil: "2026-09-01T00:00:00.000Z",
      });
      expect(sql.statements[0]).toContain("platform.site_web_build_intent_issuer_head");
      expect(sql.statements[0]).not.toMatch(/\bFOR (?:SHARE|UPDATE)\b/u);
      expect(sql.values[0]).toEqual(["site.alpha", "production"]);
      await expect(new PostgresSiteWebBuildIntentIssuerAuthority().resolveExact(
        lease.transaction,
        {
          siteRef: "site.alpha",
          environment: "production",
          key: { keyId: "key.intent.main", keyVersion: 3n, publicKeyFingerprint: digestC },
        },
      )).resolves.toMatchObject({ signingKeyId: "key.intent.main", keyVersion: 3n });
      expect(sql.statements[1]).not.toContain("site_web_build_intent_issuer_head");
      expect(sql.statements[1]).toContain("authority.signing_key_id=$3");
      expect(sql.values[1]).toEqual([
        "site.alpha", "production", "key.intent.main", "3", digestC,
      ]);
    } finally {
      revokePlatformTransaction(lease);
    }
  });

  it("resolves producer and exactly three checker keys only from static sealed trust", async () => {
    const producerRows = [producerTrustRow({
      producerRole: "web-artifact-provenance-attestor",
      signatureDomain: "application/vnd.in-toto+json",
    })];
    const checkerRows = [checkerTrustRow("artifact-inspection", "a"),
      checkerTrustRow("journey", "b"), checkerTrustRow("security", "c")];
    const sql = new ReadSql([producerRows, checkerRows]);
    const lease = issuePlatformTransaction(sql);
    try {
      const authority = new PostgresSiteReleaseEvidenceTrustAuthority();
      const result = await authority.resolveProducer(
        lease.transaction,
        {
          producerIdentityRef: "producer.web-attestor",
          environment: "production",
          producerRegistration: binding("producer.registration.main", 1n, digestA),
          signingKeyId: "key.web-attestor",
          signingKeyVersion: 2n,
        },
      );
      expect(result).toMatchObject({
        producerIdentityRef: "producer.web-attestor",
        producerRole: "web-artifact-provenance-attestor",
        signingKeyId: "key.web-attestor", signingKeyVersion: 2n,
        signatureDomain: "application/vnd.in-toto+json",
        configurationDigest: "9".repeat(64),
      });
      expect(sql.statements[0]).toContain("platform.site_release_producer_trust_revision");
      expect(sql.statements[0]).not.toContain("site_release_provenance_attestation");
      await expect(authority.resolveCheckers(lease.transaction, {
        environment: "production",
      })).resolves.toMatchObject([
        { role: "artifact-inspection", checkerIdentityRef: "checker.artifact-inspection" },
        { role: "journey", checkerIdentityRef: "checker.journey" },
        { role: "security", checkerIdentityRef: "checker.security" },
      ]);
      expect(sql.statements[1]).toContain("platform.site_release_checker_trust_revision");
      expect(sql.statements[1]).not.toContain("site_release_evidence_checker_decision");
      expect(sql.statements[0]).not.toMatch(/\bFOR (?:SHARE|UPDATE)\b/u);
    } finally {
      revokePlatformTransaction(lease);
    }
  });

  it("resolves certification trust only from its exact admitted envelope", async () => {
    const sql = new ReadSql([[producerTrustRow({
      producerRole: "release-certification-authority",
      signatureDomain: "application/vnd.kokoro.release-certification-instance.v1+json",
      detachedSignature: new Uint8Array([9, 8, 7]),
    })]]);
    const lease = issuePlatformTransaction(sql);
    try {
      await expect(new PostgresSiteReleaseCertificationTrustAuthority().resolve(
        lease.transaction,
        {
          certification: binding("certification.alpha", 3n, digestB),
          producerIdentityRef: "producer.web-attestor",
        },
      )).resolves.toMatchObject({
        producerRegistration: { ref: "producer.registration.main", digest: digestA, epoch: 4n },
        trustPolicy: { ref: "trust.policy.main", digest: digestB, epoch: 9n },
        keyId: "key.web-attestor", keyVersion: 2n,
        signatureDomain: "application/vnd.kokoro.release-certification-instance.v1+json",
        detachedSignature: new Uint8Array([9, 8, 7]),
      });
      expect(sql.statements[0]).toContain("platform.site_release_certification_envelope");
      expect(sql.statements[0]).toContain(
        "trust.configuration_digest=envelope.producer_configuration_digest",
      );
      expect(sql.statements[0]).not.toContain("site_release_provenance_attestation");
    } finally {
      revokePlatformTransaction(lease);
    }
  });

  it("loads and persists the standard WebBuildIntent DSSE envelope in the caller transaction", async () => {
    const signature = Buffer.alloc(64, 7).toString("base64");
    const payload = Buffer.from("{}", "utf8").toString("base64");
    const sql = new CaptureSql([{
      payloadType: SITE_WEB_BUILD_INTENT_PAYLOAD_TYPE,
      payload,
      signingKeyId: "key.intent.main",
      signature,
    }]);
    const lease = issuePlatformTransaction(sql);
    const repository = new PostgresSitePublicationAuthorityRepository();
    const intent = binding("web-build-intent.main", 3n, digestA);
    try {
      const envelope = await repository.loadWebBuildIntentEnvelope(lease.transaction, intent);
      expect(envelope).toEqual({
        payloadType: SITE_WEB_BUILD_INTENT_PAYLOAD_TYPE,
        payload,
        signatures: [{ keyid: "key.intent.main", sig: signature }],
      });
      await repository.insertWebBuildIntentEnvelope(lease.transaction, intent, envelope!, "command.main");
      expect(sql.statements[0]).toContain("platform.site_web_build_intent_envelope");
      expect(sql.statements[0]).not.toMatch(/\bFOR (?:SHARE|UPDATE)\b/u);
      expect(sql.statements[1]).toContain("INSERT INTO platform.site_web_build_intent_envelope");
      expect(sql.values[1]).toEqual([
        intent.ref, "3", digestA, SITE_WEB_BUILD_INTENT_PAYLOAD_TYPE,
        payload, "key.intent.main", signature, "command.main",
      ]);
    } finally {
      revokePlatformTransaction(lease);
    }
  });
});

function effectiveAccessSnapshot() {
  return {
    webBuildMaterialBundle: wireBinding("material.main", "1", digestA),
    siteConfig: wireBinding("site.config.main", "2", digestB),
    legalPolicy: wireBinding("legal.policy.main", "3", digestC),
    salesPolicy: wireBinding("sales.policy.main", "4", digestA),
    assortmentPolicy: wireBinding("assortment.policy.main", "5", digestB),
    memoryPolicy: wireBinding("memory.policy.main", "6", digestC),
    authIdentityClosure: {
      identityIssuer: wireBinding("identity.issuer.main", "1", digestA),
      authenticationPolicy: wireBinding("authentication.policy.main", "2", digestB),
      authorizationPolicy: wireBinding("authorization.policy.main", "3", digestC),
      closureDigest: digestA,
    },
    commerceClosure: {
      offerRevisions: [wireBinding("offer.main", "1", digestA)],
      entitlementTemplateRevisions: [wireBinding("entitlement.main", "1", digestC)],
      creditProgramRevisions: [wireBinding("credit.program.main", "1", digestA)],
      closureDigest: digestB,
    },
    hubClosure: {
      capabilityAssignment: wireBinding("capability.assignment.main", "1", digestA),
      capabilityCatalog: wireBinding("capability.catalog.main", "2", digestB),
      agentCatalog: wireBinding("agent.catalog.main", "3", digestC),
      closureDigest: digestC,
    },
    modelRequirements: [{
      modelRoleRef: "model.role.main",
      modelInventory: { ref: "model.inventory.main", digest: digestA },
      modelCatalog: { ref: "model.catalog.main", digest: digestB },
    }],
  };
}

function expectedEffectiveAccess() {
  const value = effectiveAccessSnapshot();
  return {
    ...value,
    webBuildMaterialBundle: domainBinding(value.webBuildMaterialBundle),
    siteConfig: domainBinding(value.siteConfig), legalPolicy: domainBinding(value.legalPolicy),
    salesPolicy: domainBinding(value.salesPolicy), assortmentPolicy: domainBinding(value.assortmentPolicy),
    memoryPolicy: domainBinding(value.memoryPolicy),
    authIdentityClosure: {
      identityIssuer: domainBinding(value.authIdentityClosure.identityIssuer),
      authenticationPolicy: domainBinding(value.authIdentityClosure.authenticationPolicy),
      authorizationPolicy: domainBinding(value.authIdentityClosure.authorizationPolicy),
      closureDigest: value.authIdentityClosure.closureDigest,
    },
    commerceClosure: {
      offerRevisions: value.commerceClosure.offerRevisions.map(domainBinding),
      entitlementTemplateRevisions: value.commerceClosure.entitlementTemplateRevisions.map(domainBinding),
      creditProgramRevisions: value.commerceClosure.creditProgramRevisions.map(domainBinding),
      closureDigest: value.commerceClosure.closureDigest,
    },
    hubClosure: {
      capabilityAssignment: domainBinding(value.hubClosure.capabilityAssignment),
      capabilityCatalog: domainBinding(value.hubClosure.capabilityCatalog),
      agentCatalog: domainBinding(value.hubClosure.agentCatalog),
      closureDigest: value.hubClosure.closureDigest,
    },
  };
}

function wireBinding(ref: string, revision: string, digest: string) {
  return { ref, revision, digest };
}
function binding(ref: string, revision: bigint, digest: string) {
  return { ref, revision, digest };
}
function domainBinding(value: ReturnType<typeof wireBinding>) {
  return { ...value, revision: BigInt(value.revision) };
}
function producerTrustRow(input: Readonly<{
  producerRole: string;
  signatureDomain: string;
  detachedSignature?: Uint8Array;
}>) {
  return {
    ...input,
    producerIdentityRef: "producer.web-attestor",
    producerRegistrationRef: "producer.registration.main",
    producerRegistrationRevision: "1",
    producerRegistrationDigest: digestA,
    producerRegistryEpoch: "4",
    trustPolicyRef: "trust.policy.main",
    trustPolicyRevision: "1",
    trustPolicyDigest: digestB,
    trustPolicyEpoch: "9",
    signingKeyId: "key.web-attestor",
    signingKeyVersion: "2",
    environment: "production",
    keyStatus: "active",
    keyValidFrom: "2026-07-01T00:00:00.000Z",
    keyValidUntil: "2026-09-01T00:00:00.000Z",
    publicKeySpkiPem: publicKeyPem,
    signingKeyFingerprint: digestC,
    configurationDigest: "9".repeat(64),
  };
}

function checkerTrustRow(role: string, character: string) {
  return {
    environment: "production", checkerRole: role, checkerIdentityRef: `checker.${role}`,
    checkerRegistrationRef: `registration.${role}`, checkerRegistrationRevision: "1",
    checkerRegistrationDigest: digestA, trustPolicyRef: `trust.${role}`,
    trustPolicyRevision: "2", trustPolicyDigest: digestB, trustPolicyEpoch: "3",
    signingKeyId: `key.${role}`, signingKeyVersion: "4",
    signingKeyFingerprint: `sha256:${character.repeat(64)}`,
    signatureDomain: "application/vnd.kokoro.release-evidence-decision.v1+json",
    keyStatus: "active", keyValidFrom: "2026-07-01T00:00:00.000Z",
    keyValidUntil: "2026-09-01T00:00:00.000Z", publicKeySpkiPem: publicKeyPem,
    configurationDigest: "8".repeat(64),
  };
}
