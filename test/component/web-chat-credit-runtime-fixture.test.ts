import { execFileSync } from "node:child_process";
import { createHash, verify, X509Certificate } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createPlatformPublicProductionComposition } from
  "../../src/process/platform-public-composition.js";
import { PLATFORM_API_RUNTIME_CONTRACT } from
  "../../src/process/platform-api-runtime-contract.js";
import {
  PLATFORM_FIXTURE_API_RUNTIME_FILE_FIELDS,
  createPlatformFixtureApiRuntimeAuthority,
  createPlatformFixtureModel,
  createPlatformFixtureObservation,
  createPlatformFixturePreparedResult,
  createPlatformFixtureSetupResult,
  createPlatformFixtureAuthorizationEventAuthority,
  createPlatformFixtureSessionAccessAuthority,
  parsePlatformFixtureCommand,
} from "../fixtures/web-chat-credit-runtime.js";

const platformApiRuntimeFiles = Object.freeze(Object.fromEntries(
  [
    "productWorkloadRegistryFile",
    "sessionAccessKeyRingFile",
    "authorizationEventKeyRingFile",
    "platformPublicTlsKeyFile",
    "platformPublicTlsCertificateFile",
    "platformPublicTlsClientCaFile",
    "commerceRedemptionKeyRingFile",
    "assetUploadPolicyRegistryFile",
    "assetUploadCapabilityKeyRingFile",
    "artifactDeliveryCapabilityKeyFile",
    "artifactOwnerCursorKeyFile",
    "identityPasswordPepperRingFile",
    "identityVerificationDigestKeyFile",
    "identitySessionDigestKeyFile",
    "identityRefreshDigestKeyFile",
    "identityReauthenticationDigestKeyFile",
    "identityAuditDigestKeyFile",
    "identityDeliveryKeyFile",
    "identityTotpKeyRingFile",
  ].map((field) => [field, `/private/runtime/${field}`]),
)) as Readonly<Record<typeof PLATFORM_FIXTURE_API_RUNTIME_FILE_FIELDS[number], string>>;

const fixtureSource = readFileSync(new URL(
  "../fixtures/web-chat-credit-runtime.ts",
  import.meta.url,
), "utf8");
const modelGatewayMigrationSource = readFileSync(new URL(
  "../../prisma/migrations/20260802_1200_model_gateway_attempt_producer/migration.sql",
  import.meta.url,
), "utf8");

describe("Platform-owned Web Chat Credit runtime fixture", () => {
  it("defaults to direct and binds each explicit provider without fallback", () => {
    const siteId = "site:web-chat-credit-runtime";
    const firstDirect = createPlatformFixtureModel(siteId, {});
    const retriedDirect = createPlatformFixtureModel(siteId, {});
    const explicitDirect = createPlatformFixtureModel(siteId, {
      PLATFORM_FIXTURE_MODEL_PROVIDER: "direct",
    });
    const firstLiteLlm = createPlatformFixtureModel(siteId, {
      PLATFORM_FIXTURE_MODEL_PROVIDER: "litellm",
    });
    const retriedLiteLlm = createPlatformFixtureModel(siteId, {
      PLATFORM_FIXTURE_MODEL_PROVIDER: "litellm",
    });

    const selectedAdapter = (fixture: typeof firstDirect) => fixture.inventory.document.providers
      .find((provider) => provider.key === fixture.inventory.document.bindings[0]?.providerKey)
      ?.adapterKind;
    expect(selectedAdapter(firstDirect)).toBe("direct");
    expect(selectedAdapter(firstLiteLlm)).toBe("litellm");
    expect(firstDirect.inventory.digest).toBe(explicitDirect.inventory.digest);
    expect(firstDirect.modelOptionRevisionRef).toBe(explicitDirect.modelOptionRevisionRef);
    expect(firstDirect.inventory.digest).toBe(retriedDirect.inventory.digest);
    expect(firstDirect.modelOptionRevisionRef).toBe(retriedDirect.modelOptionRevisionRef);
    expect(firstLiteLlm.inventory.digest).toBe(retriedLiteLlm.inventory.digest);
    expect(firstLiteLlm.modelOptionRevisionRef).toBe(retriedLiteLlm.modelOptionRevisionRef);
    expect(firstDirect.inventory.digest).not.toBe(firstLiteLlm.inventory.digest);
    expect(firstDirect.modelOptionRevisionRef).not.toBe(firstLiteLlm.modelOptionRevisionRef);
    expect(() => createPlatformFixtureModel(siteId, {
      PLATFORM_FIXTURE_MODEL_PROVIDER: "unknown",
    })).toThrow("PLATFORM_FIXTURE_MODEL_PROVIDER_INVALID");
    expect(fixtureSource.match(
      /createPlatformFixtureModel\(configuration\.siteId, environment\)/gu,
    )).toHaveLength(2);
  });

  it("accepts only prepare, finalize, and observe fixture commands", () => {
    expect(parsePlatformFixtureCommand(["prepare"])).toBe("prepare");
    expect(parsePlatformFixtureCommand(["finalize"])).toBe("finalize");
    expect(parsePlatformFixtureCommand(["observe"])).toBe("observe");
    expect(() => parsePlatformFixtureCommand([])).toThrow("PLATFORM_FIXTURE_COMMAND_INVALID");
    expect(() => parsePlatformFixtureCommand(["prepare", "extra"]))
      .toThrow("PLATFORM_FIXTURE_COMMAND_INVALID");
    expect(() => parsePlatformFixtureCommand(["setup"])).toThrow("PLATFORM_FIXTURE_COMMAND_INVALID");
    expect(() => parsePlatformFixtureCommand(["seed"])).toThrow("PLATFORM_FIXTURE_COMMAND_INVALID");
  });

  it("returns the release binding required by Session and Hub before activation", () => {
    const result = createPlatformFixturePreparedResult({
      siteId: "site:web-chat-credit-runtime",
      siteReleaseRef: "release:web-chat-credit-runtime",
      siteProjectBindingRef: "binding:web-chat-credit-runtime",
      workloadIdentityId: "spiffe://kokoro.test/site/web-chat-credit-runtime",
      deploymentRef: "deployment:web-chat-credit-runtime",
      webArtifactDigest: "d".repeat(64),
      modelOptionRevisionRef: `model-option:sha256:${"a".repeat(64)}`,
      agentCatalogRef: `agent-catalog:sha256:${"b".repeat(64)}`,
    });
    expect(result.kind).toBe("platform-web-chat-credit-runtime-prepared");
    expect(JSON.stringify(result)).not.toMatch(/subjectRef|billingAccountRef|sessionCredential/iu);
  });

  it("returns only bounded public references and private-file paths from setup", () => {
    const result = createPlatformFixtureSetupResult({
      siteId: "site:web-chat-credit-runtime",
      siteReleaseRef: "release:web-chat-credit-runtime",
      siteProjectBindingRef: "binding:web-chat-credit-runtime",
      workloadIdentityId: "spiffe://kokoro.test/site/web-chat-credit-runtime",
      deploymentRef: "deployment:web-chat-credit-runtime",
      webArtifactDigest: "d".repeat(64),
      subjectRef: "subject:web-chat-credit-runtime",
      subjectGeneration: "1",
      projectRef: "project:web-chat-credit-runtime",
      billingAccountRef: "billing:web-chat-credit-runtime",
      ratingPolicyRevisionRef: "rating-policy:web-chat-credit-runtime-v1",
      sessionCredentialFile: "/private/runtime/session-credential",
      sessionAccessGrantFile: "/private/runtime/session-access-grant",
      platformApiTrustRoot: "/private/runtime",
      platformPublicTlsCertificateAuthorityFile: "/private/runtime/platform-public-ca.crt",
      browserAuthFile: "/private/runtime/browser-auth.json",
      siteBffClientCertificateFile: "/private/runtime/site-bff-client.crt",
      siteBffWorkloadCredentialFile: "/private/runtime/site-bff.credential",
      ...platformApiRuntimeFiles,
      authorizationEventVerificationKeySetFile:
        "/private/runtime/authorization-event-verification-key-set.json",
      sessionAccessVerificationKeySetFile:
        "/private/runtime/session-access-verification-key-set.json",
      modelOptionRevisionRef: `model-option:sha256:${"a".repeat(64)}`,
      agentCatalogRef: `agent-catalog:sha256:${"b".repeat(64)}`,
    });
    expect(result).toEqual({
      schemaVersion: 1,
      kind: "platform-web-chat-credit-runtime-setup",
      siteId: "site:web-chat-credit-runtime",
      siteReleaseRef: "release:web-chat-credit-runtime",
      siteProjectBindingRef: "binding:web-chat-credit-runtime",
      workloadIdentityId: "spiffe://kokoro.test/site/web-chat-credit-runtime",
      deploymentRef: "deployment:web-chat-credit-runtime",
      webArtifactDigest: "d".repeat(64),
      subjectRef: "subject:web-chat-credit-runtime",
      subjectGeneration: "1",
      projectRef: "project:web-chat-credit-runtime",
      billingAccountRef: "billing:web-chat-credit-runtime",
      ratingPolicyRevisionRef: "rating-policy:web-chat-credit-runtime-v1",
      sessionCredentialFile: "/private/runtime/session-credential",
      sessionAccessGrantFile: "/private/runtime/session-access-grant",
      platformApiTrustRoot: "/private/runtime",
      platformPublicTlsCertificateAuthorityFile: "/private/runtime/platform-public-ca.crt",
      browserAuthFile: "/private/runtime/browser-auth.json",
      siteBffClientCertificateFile: "/private/runtime/site-bff-client.crt",
      siteBffWorkloadCredentialFile: "/private/runtime/site-bff.credential",
      ...platformApiRuntimeFiles,
      authorizationEventVerificationKeySetFile:
        "/private/runtime/authorization-event-verification-key-set.json",
      sessionAccessVerificationKeySetFile:
        "/private/runtime/session-access-verification-key-set.json",
      modelOptionRevisionRef: `model-option:sha256:${"a".repeat(64)}`,
      agentCatalogRef: `agent-catalog:sha256:${"b".repeat(64)}`,
    });
    expect(JSON.stringify(result)).not.toMatch(
      /"(?:amount|balance|password|credential|token|secret)"\s*:/iu,
    );
    expect(() => createPlatformFixtureSetupResult({
      ...result,
      deploymentRef: "",
    })).toThrow("PLATFORM_FIXTURE_SETUP_RESULT_INVALID");
    expect(() => createPlatformFixtureSetupResult({
      ...result,
      webArtifactDigest: "not-a-digest",
    })).toThrow("PLATFORM_FIXTURE_SETUP_RESULT_INVALID");
    expect(() => createPlatformFixtureSetupResult({
      ...result,
      authorizationEventVerificationKeySetFile: "relative/key-set.json",
    })).toThrow("PLATFORM_FIXTURE_SETUP_RESULT_INVALID");
    expect(PLATFORM_FIXTURE_API_RUNTIME_FILE_FIELDS).toEqual(Object.keys(platformApiRuntimeFiles));
    expect(() => createPlatformFixtureSetupResult({
      ...result,
      identitySessionDigestKeyFile: "relative/identity-session-digest.key",
    })).toThrow("PLATFORM_FIXTURE_SETUP_RESULT_INVALID");
  });

  it("returns fixed observation booleans and counts without rows, refs, content, or amounts", () => {
    const result = createPlatformFixtureObservation({
      providerInvocationCount: 1,
      providerAttemptCount: 1,
      finalizedEvidenceCount: 1,
      segmentSettlementCount: 1,
      captureJournalCount: 1,
      providerEffectOnce: true,
      evidenceChainFinalized: true,
      creditSettledOnce: true,
      replayStable: true,
      availableConsumedDeltaEqual: true,
    });
    expect(result).toEqual({ schemaVersion: 1, kind: "platform-web-chat-credit-runtime-observation",
      providerInvocationCount: 1, providerAttemptCount: 1, finalizedEvidenceCount: 1,
      segmentSettlementCount: 1, captureJournalCount: 1, providerEffectOnce: true,
      evidenceChainFinalized: true, creditSettledOnce: true, replayStable: true,
      availableConsumedDeltaEqual: true });
    expect(Object.keys(result).some((key) =>
      ["ref", "payload", "content", "amount", "balance", "credential", "token", "secret"]
        .includes(key.toLowerCase()))).toBe(false);
    expect(() => createPlatformFixtureObservation({ ...result, providerInvocationCount: -1 }))
      .toThrow("PLATFORM_FIXTURE_OBSERVATION_INVALID");
  });

  it("sets the Gateway workload context required by FORCE RLS before observing Gateway rows", () => {
    expect(modelGatewayMigrationSource).toContain(
      "ALTER TABLE platform.model_gateway_invocation FORCE ROW LEVEL SECURITY",
    );
    expect(modelGatewayMigrationSource).toContain(
      "ALTER TABLE platform.model_gateway_attempt_usage_fact FORCE ROW LEVEL SECURITY",
    );
    expect(modelGatewayMigrationSource).toMatch(
      /current_setting\('app\.workload_kind',true\)='platform_model_gateway'/u,
    );
    const observeSource = fixtureSource.slice(
      fixtureSource.indexOf("export async function observePlatformFixture"),
      fixtureSource.indexOf("export function createPlatformFixtureModel"),
    );
    expect(observeSource).toContain(
      "set_config('app.workload_kind','platform_model_gateway',true)",
    );
  });

  it("never seeds or reads business rows through ad-hoc mutation SQL", () => {
    expect(fixtureSource).not.toMatch(/(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+platform\./iu);
    expect(fixtureSource).toContain("SitePublicationService");
    expect(fixtureSource).toContain("IdentityApplicationService");
    expect(fixtureSource).toContain("PostgresCreditGrantIssuer");
    expect(fixtureSource).toContain("RatingPolicyPublicationService");
    expect(fixtureSource).toContain("AdmissionLaunchProfilePublicationService");
    expect(fixtureSource).toContain("createProductModelOptionAdministrationComposition");
    expect(fixtureSource).not.toContain("PostgresCapabilityCatalogProjectionRepository");
    expect(fixtureSource).toContain("IssueSessionAccessGrantService");
  });

  it("does not pre-authorize fabricated Session, launch, or run owner references", () => {
    expect(fixtureSource).not.toContain("setupAdmission(");
    expect(fixtureSource).not.toMatch(/:session:1|:launch:1|:run:1/u);
    expect(fixtureSource).not.toContain("createPlatformAdmissionOwnerAuthority");
  });

  it("keeps Credit Program publication on Admin and Grant issuance on API", () => {
    expect(fixtureSource).toContain(
      "const creditProgramUnitOfWork = new PlatformUnitOfWork(admin);",
    );
    expect(fixtureSource).toContain(
      "const grantUnitOfWork = new PlatformUnitOfWork(api);",
    );
    expect(fixtureSource).toContain(
      "issuer.prepareIssuance(transaction, { commandId: null, grants:",
    );
  });

  it("uses the canonical HTTPS issuer required by the production Grant signer", () => {
    expect(fixtureSource).toContain('issuer: "https://fixture.kokoro.test/"');
    expect(fixtureSource).toContain(
      "const signerNow = new Date(Math.floor(Date.now() / 1_000) * 1_000);",
    );
  });

  it("signs every Authorization feed event with one verifiable production RSA authority", async () => {
    const authority = await createPlatformFixtureAuthorizationEventAuthority();
    const sessionAccess = await createPlatformFixtureSessionAccessAuthority();
    const payload = Buffer.from("platform-fixture-authorization-event", "utf8");
    const signature = await authority.signer.sign(payload);

    expect(authority.signer.keyRevision).toBe(authority.verificationKey.keyRevision);
    expect(verify("sha256", payload, authority.verificationKey.publicKeyPem, signature)).toBe(true);
    expect(sessionAccess.signer.keyRevision).toBe(sessionAccess.verificationKey.keyRevision);
    expect(sessionAccess.keyRing.version).toBe(2);
    expect(fixtureSource).not.toContain("new Uint8Array(64).fill(7)");
  });

  it("writes the versioned browser login envelope consumed by the Web fixture", () => {
    expect(fixtureSource).toContain(
      "writePrivateJson(browserAuthFile, { schemaVersion: 1, email, password })",
    );
  });

  it("materializes one production-loadable API authority from the real Site BFF trust", async () => {
    const privateDirectory = mkdtempSync(join(tmpdir(), "kokoro-platform-fixture-"));
    try {
      const workloadIdentityId = "spiffe://kokoro.test/site/web-chat-credit-runtime";
      const sessionTrust = createSessionTrust(privateDirectory, workloadIdentityId);
      const [authorizationEventAuthority, sessionAccessAuthority] = await Promise.all([
        createPlatformFixtureAuthorizationEventAuthority(),
        createPlatformFixtureSessionAccessAuthority(),
      ]);
      const authority = await createPlatformFixtureApiRuntimeAuthority({
        privateDirectory,
        site: {
          siteRef: "site:web-chat-credit-runtime",
          siteReleaseRef: "release:web-chat-credit-runtime",
          siteProjectBindingRef: "binding:web-chat-credit-runtime",
          workloadIdentityId,
          deploymentRef: "deployment:web-chat-credit-runtime",
          webArtifactDigest: "d".repeat(64),
        },
        siteBffClientCertificateFile: sessionTrust.clientCertificateFile,
        siteBffWorkloadCredentialFile: sessionTrust.workloadCredentialFile,
        siteBffCertificateAuthorityFile: sessionTrust.certificateAuthorityFile,
        authorizationEventAuthority,
        sessionAccessAuthority,
      });

      expect(Object.keys(authority.runtimeFiles)).toEqual(PLATFORM_FIXTURE_API_RUNTIME_FILE_FIELDS);
      for (const path of Object.values(authority.runtimeFiles)) {
        expect(path.startsWith(`${authority.platformApiTrustRoot}/`)).toBe(true);
      }
      const registration = JSON.parse(readFileSync(
        authority.runtimeFiles.productWorkloadRegistryFile,
        "utf8",
      )).registrations[0];
      const clientCertificate = new X509Certificate(
        readFileSync(sessionTrust.clientCertificateFile),
      );
      expect(registration).toMatchObject({
        certificateSha256: createHash("sha256").update(clientCertificate.raw).digest("hex"),
        csrfSha256: createHash("sha256").update(sessionTrust.workloadCredential).digest("hex"),
        audience: "site-product",
        allowedOperations: [
          "createIdentitySession",
          "exchangeProductContext",
          "listIdentitySessions",
          "listAccountProducts",
          "getCreditSummary",
          "getPersonalContext",
          "issueSessionAccessGrant",
        ],
      });
      expect(readFileSync(authority.siteBffClientCertificateFile, "utf8"))
        .toBe(readFileSync(sessionTrust.clientCertificateFile, "utf8"));
      expect(readFileSync(authority.siteBffWorkloadCredentialFile, "utf8"))
        .toBe(sessionTrust.workloadCredential);

      const environment = Object.fromEntries(PLATFORM_API_RUNTIME_CONTRACT.files.map((entry, index) => [
        entry.environment,
        authority.runtimeFiles[PLATFORM_FIXTURE_API_RUNTIME_FILE_FIELDS[index]!],
      ]));
      await expect(createPlatformPublicProductionComposition({
        database: {} as never,
        environment: {
          ...environment,
          PLATFORM_API_FILE_TRUST_ROOT: authority.platformApiTrustRoot,
        },
      })).resolves.toMatchObject({ secure: true });
    } finally {
      rmSync(privateDirectory, { recursive: true, force: true });
    }
  }, 20_000);

  it("binds the deterministic empty Hub catalog without pre-projecting it", () => {
    const launchProfile = fixtureSource.indexOf(
      "new AdmissionLaunchProfilePublicationService",
    );
    const catalogBinding = fixtureSource.indexOf("agentCatalogRef: fixture.agentCatalogRef");
    const prepareStart = fixtureSource.indexOf("async function prepareSite");
    const finalizeStart = fixtureSource.indexOf("async function finalizeSite");
    const beginActivation = fixtureSource.indexOf("adminLifecycle.beginActivation", finalizeStart);
    const runActivation = fixtureSource.indexOf(
      "SiteRuntimeDispatcher(state, providers).runActivation",
      finalizeStart,
    );
    const modelCatalog = fixtureSource.indexOf(
      "modelControl.publishSiteRelease.publish",
    );
    expect(launchProfile).toBeGreaterThan(-1);
    expect(catalogBinding).toBeGreaterThan(-1);
    expect(prepareStart).toBeGreaterThan(-1);
    expect(finalizeStart).toBeGreaterThan(prepareStart);
    expect(fixtureSource.slice(prepareStart, finalizeStart)).not.toContain("beginActivation");
    expect(beginActivation).toBeGreaterThan(finalizeStart);
    expect(runActivation).toBeGreaterThan(beginActivation);
    expect(modelCatalog).toBeGreaterThan(runActivation);
  });

  it("generates a fresh UUID for every synthetic activation approval", () => {
    const finalizeStart = fixtureSource.indexOf("async function finalizeSite");
    const finalizeEnd = fixtureSource.indexOf("async function setupIdentity", finalizeStart);
    const finalizeSource = fixtureSource.slice(finalizeStart, finalizeEnd);

    expect([...finalizeSource.matchAll(/approvalRef: randomUUID\(\)/gu)]).toHaveLength(1);
    expect(finalizeSource).not.toContain(":approval:1");
    expect(finalizeSource).not.toContain("10000000-0000-4000-8000-000000000001");
  });
});

function createSessionTrust(privateDirectory: string, workloadIdentityId: string) {
  const certificateAuthorityFile = join(privateDirectory, "session-ca.pem");
  const certificateAuthorityKeyFile = join(privateDirectory, "session-ca-key.pem");
  const clientCertificateFile = join(privateDirectory, "site-bff.pem");
  const clientPrivateKeyFile = join(privateDirectory, "site-bff-key.pem");
  const requestFile = join(privateDirectory, "site-bff.csr");
  const extensionsFile = join(privateDirectory, "site-bff-extensions.cnf");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes",
    "-keyout", certificateAuthorityKeyFile, "-out", certificateAuthorityFile, "-days", "1",
    "-sha256", "-subj", "/CN=Kokoro fixture Session CA",
    "-addext", "basicConstraints=critical,CA:TRUE,pathlen:0",
    "-addext", "keyUsage=critical,keyCertSign,cRLSign"], { stdio: "ignore" });
  execFileSync("openssl", ["req", "-new", "-newkey", "rsa:2048", "-nodes",
    "-keyout", clientPrivateKeyFile, "-out", requestFile,
    "-subj", "/CN=site-bff.fixture.local", "-addext", `subjectAltName=URI:${workloadIdentityId}`],
  { stdio: "ignore" });
  writeFileSync(extensionsFile, [
    "basicConstraints=critical,CA:FALSE",
    "keyUsage=critical,digitalSignature,keyEncipherment",
    "extendedKeyUsage=clientAuth",
    `subjectAltName=URI:${workloadIdentityId}`,
    "",
  ].join("\n"));
  execFileSync("openssl", ["x509", "-req", "-in", requestFile, "-CA", certificateAuthorityFile,
    "-CAkey", certificateAuthorityKeyFile, "-CAcreateserial", "-out", clientCertificateFile,
    "-days", "1", "-sha256", "-extfile", extensionsFile], { stdio: "ignore" });
  const workloadCredential = Buffer.alloc(32, 7).toString("base64url");
  const workloadCredentialFile = join(privateDirectory, "site-bff.credential");
  writeFileSync(workloadCredentialFile, workloadCredential, { mode: 0o600 });
  return Object.freeze({ certificateAuthorityFile, clientCertificateFile, workloadCredentialFile,
    workloadCredential });
}
