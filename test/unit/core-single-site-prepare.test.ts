import { createHash, createPublicKey } from "node:crypto";
import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CORE_SINGLE_SITE_METADATA_ENDPOINT,
  coreSingleSitePrepareArguments,
  loadCoreSingleSitePrepareInputs,
  prepareCoreSingleSiteState,
  runCoreSingleSitePrepareMain,
} from
  "../../src/process/core-single-site-prepare.js";
import {
  CORE_SINGLE_SITE_BOOTSTRAP_CHECKER_OPERATIONS,
  CORE_SINGLE_SITE_BOOTSTRAP_MAKER_OPERATIONS,
  prepareCoreSingleSiteBootstrapExecution,
} from "../../src/process/core-single-site-bootstrap-composition.js";
import { parseCoreBootstrapAdminAttestationBundle } from
  "../../src/process/core-single-site-bootstrap-attestation.js";
import {
  Ed25519SiteReleaseCertificationAuthority,
  parseSiteReleaseCertificationKeys,
} from "../../src/modules/site/infrastructure/crypto/site-release-certification-authority.js";
import { assertFixedSiteProviderBinding } from
  "../../src/modules/site/infrastructure/rpc/site-provider-registry-config.js";
import {
  loadAuthorizationEventKeyRing,
  loadIdentityAuditDigester,
  loadIdentityPasswordHasher,
  loadRedemptionSecretCodec,
} from "../../src/process/platform-public-composition.js";
import { createSessionAuthorizationEventSigner } from
  "../../src/modules/authorization/infrastructure/jose/session-authorization-event-signer.js";
import { AUTHORIZATION_PUBLIC_OPERATION_IDS } from
  "../../src/modules/authorization/interfaces/http/authorization-public-operations.js";
import { IDENTITY_LAUNCH_OPERATION_IDS } from
  "../../src/modules/identity/interfaces/http/identity-public-operations.js";
import { COMMERCE_PUBLIC_OPERATION_IDS } from
  "../../src/modules/commerce/interfaces/http/commerce-public-operations.js";
import { ASSET_PUBLIC_OPERATION_IDS } from
  "../../src/modules/asset/interfaces/http/asset-public-operations.js";
import { ARTIFACT_PUBLIC_OPERATION_IDS } from
  "../../src/modules/artifact/interfaces/http/artifact-public-operations.js";
import { MEDIA_PUBLIC_OPERATION_IDS } from
  "../../src/modules/media/interfaces/http/media-public-operations.js";
import { loadAuthorizationVerificationKeys } from
  "../../src/process/session-authorization-composition.js";
import type { CoreSingleSiteBootstrapDocument } from
  "../../src/process/core-single-site-bootstrap-document.js";

const FEATURE_OFF_IDENTITY_OPERATION_IDS = Object.freeze([
  "beginRegistration",
  "resendEmailVerification",
  "completeEmailVerification",
] as const);
const FEATURE_OFF_IDENTITY_OPERATION_ID_SET: ReadonlySet<string> =
  new Set(FEATURE_OFF_IDENTITY_OPERATION_IDS);
const CORE_SAFE_FACT_ENVIRONMENT_NAMES = Object.freeze([
  "KOKORO_SITE_ID",
  "KOKORO_SITE_KEY",
  "KOKORO_SITE_PROJECT_BINDING_REF",
  "KOKORO_SITE_WORKLOAD_IDENTITY_ID",
  "KOKORO_PRODUCT_AUDIENCE",
  "KOKORO_SESSION_CONTRACT_REVISION",
  "KOKORO_SITE_BINDING_EPOCH",
  "KOKORO_SITE_SECURITY_EPOCH",
  "KOKORO_SITE_POLICY_EPOCH",
  "KOKORO_PLATFORM_PUBLIC_OPERATION_IDS_JSON",
] as const);

describe("core single-Site prepare", () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })));
  });

  it("accepts exactly the four absolute preflight paths", () => {
    expect(coreSingleSitePrepareArguments([
      "--operator-config", "/input/operator.json",
      "--web-report", "/input/web-report.json",
      "--deployment-facts", "/input/deployment-facts.json",
      "--state-directory", "/state/core",
    ])).toEqual({
      operatorConfig: "/input/operator.json",
      webReport: "/input/web-report.json",
      deploymentFacts: "/input/deployment-facts.json",
      stateDirectory: "/state/core",
    });
  });

  it.each([
    { argv: [] },
    { argv: ["--operator-config", "relative.json", "--web-report", "/web.json",
      "--deployment-facts", "/facts.json", "--state-directory", "/state"] },
    { argv: ["--operator-config", "/operator.json", "--web-report", "/web.json",
      "--deployment-facts", "/facts.json", "--unknown", "/state"] },
    { argv: ["--operator-config", "/operator.json", "--operator-config", "/other.json",
      "--deployment-facts", "/facts.json", "--state-directory", "/state"] },
    { argv: ["--operator-config", "/operator\n.json", "--web-report", "/web.json",
      "--deployment-facts", "/facts.json", "--state-directory", "/state"] },
    { argv: ["--operator-config", "/same.json", "--web-report", "/same.json",
      "--deployment-facts", "/facts.json", "--state-directory", "/state"] },
  ])("rejects an argv set outside the closed selector contract", ({ argv }) => {
    expect(() => coreSingleSitePrepareArguments(argv)).toThrow(
      "CORE_SINGLE_SITE_PREPARE_ARGUMENTS_INVALID",
    );
  });

  it("loads the strict minimal operator, verified Web report, and deployment facts", async () => {
    const fixture = await inputFixture();

    const loaded = await loadCoreSingleSitePrepareInputs(fixture.paths);

    expect(loaded.operatorConfig).toEqual({
      schemaVersion: 1,
      ownerEmail: "owner@example.com",
      model: {
        endpoint: "https://direct-model.internal/v1",
        modelKey: "gpt-5.4-mini",
      },
    });
    expect(loaded.webReport).toMatchObject({
      kind: "kokoro.core-site-release",
      siteId: "site:core",
      siteKey: "core-site",
      releaseId: "core.2026.08.11.001",
      image: `registry.example/kokoro/core@sha256:${"d".repeat(64)}`,
      webArtifactDigest: "d".repeat(64),
    });
    expect(loaded.deploymentFacts).toEqual(fixture.deploymentFacts);
    expect(loaded.deploymentFacts).not.toHaveProperty("releaseManifestDigest");
    expect(loaded.digests).toEqual({
      operatorConfig: sha(fixture.operatorText),
      webReport: sha(fixture.webReportText),
      deploymentFacts: sha(fixture.deploymentFactsText),
      installation: expect.stringMatching(/^[a-f0-9]{64}$/u),
      prepareFacts: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    expect(CORE_SINGLE_SITE_METADATA_ENDPOINT).toBe(
      "http://kokoro-site-release.internal:3000/api/release/metadata",
    );
  });

  it.each([
    ["report digest", (value: DeploymentFacts) => ({ ...value, webReportDigest: "e".repeat(64) })],
    ["exact image", (value: DeploymentFacts) => ({
      ...value,
      siteImage: `registry.example/kokoro/other@sha256:${"d".repeat(64)}`,
    })],
    ["artifact digest", (value: DeploymentFacts) => ({
      ...value,
      siteImage: `registry.example/kokoro/core@sha256:${"e".repeat(64)}`,
      webArtifactDigest: "e".repeat(64),
    })],
  ] as const)("rejects a deployment %s that disagrees with the verified Web report",
    async (_axis, mutate) => {
      const fixture = await inputFixture();
      await writePrivate(fixture.paths.deploymentFactsPath, mutate(fixture.deploymentFacts));

      await expect(loadCoreSingleSitePrepareInputs(fixture.paths)).rejects.toThrow(
        "CORE_SINGLE_SITE_PREPARE_FACTS_MISMATCH",
      );
    });

  it("rejects a configurable fixed-Site metadata address", async () => {
    const fixture = await inputFixture();
    await writePrivate(fixture.paths.deploymentFactsPath, {
      ...fixture.deploymentFacts,
      metadataEndpoint: "http://other.internal:3000/api/release/metadata",
    });

    await expect(loadCoreSingleSitePrepareInputs(fixture.paths)).rejects.toThrow(
      "CORE_SINGLE_SITE_PREPARE_DEPLOYMENT_FACTS_INVALID",
    );
  });

  it.each([
    `localhost:5000/kokoro/core@sha256:${"d".repeat(64)}`,
    `registry.invalid/kokoro/core@sha256:${"d".repeat(64)}`,
  ])("rejects an unsafe verified Web image reference %s", async (image) => {
    const fixture = await inputFixture();
    const report = JSON.parse(fixture.webReportText) as Record<string, unknown>;
    await writePrivate(fixture.paths.webReportPath, { ...report, image });

    await expect(loadCoreSingleSitePrepareInputs(fixture.paths)).rejects.toThrow(
      "CORE_SINGLE_SITE_PREPARE_WEB_REPORT_INVALID",
    );
  });

  it.each([
    ["platform image", {
      platformImage: `localhost:5000/kokoro/platform@sha256:${"e".repeat(64)}`,
    }],
    ["public origin", { publicOrigin: "https://core.invalid" }],
  ] as const)("rejects an unsafe deployment %s", async (_axis, mutation) => {
    const fixture = await inputFixture();
    await writePrivate(fixture.paths.deploymentFactsPath, {
      ...fixture.deploymentFacts,
      ...mutation,
    });

    await expect(loadCoreSingleSitePrepareInputs(fixture.paths)).rejects.toThrow(
      "CORE_SINGLE_SITE_PREPARE_DEPLOYMENT_FACTS_INVALID",
    );
  });

  it("rejects a placeholder Direct endpoint", async () => {
    const fixture = await inputFixture();
    await writePrivate(fixture.paths.operatorConfigPath, {
      ...fixture.operatorConfig,
      model: { ...fixture.operatorConfig.model, endpoint: "https://direct-model.invalid/v1" },
    });

    await expect(loadCoreSingleSitePrepareInputs(fixture.paths)).rejects.toThrow(
      "CORE_SINGLE_SITE_PREPARE_OPERATOR_CONFIG_INVALID",
    );
  });

  it("rejects a model key outside the production inventory identifier contract", async () => {
    const fixture = await inputFixture();
    await writePrivate(fixture.paths.operatorConfigPath, {
      ...fixture.operatorConfig,
      model: { ...fixture.operatorConfig.model, modelKey: "gpt/model" },
    });

    await expect(loadCoreSingleSitePrepareInputs(fixture.paths)).rejects.toThrow(
      "CORE_SINGLE_SITE_PREPARE_OPERATOR_CONFIG_INVALID",
    );
  });

  it("rejects a non-private input before reading its JSON", async () => {
    const fixture = await inputFixture();
    await chmod(fixture.paths.operatorConfigPath, 0o640);

    await expect(loadCoreSingleSitePrepareInputs(fixture.paths)).rejects.toThrow(
      "CORE_SINGLE_SITE_PREPARE_OPERATOR_CONFIG_FILE_INVALID",
    );
  });

  it("rejects a state path that is not an owner-only directory", async () => {
    const fixture = await inputFixture();
    const inputs = await loadCoreSingleSitePrepareInputs(fixture.paths);
    const stateDirectory = join(fixture.directory, "state");
    await writeFile(stateDirectory, "not-a-private-directory", { mode: 0o600 });

    await expect(prepareCoreSingleSiteState({ inputs, stateDirectory })).rejects.toThrow(
      "CORE_SINGLE_SITE_PREPARE_STATE_DIRECTORY_INVALID",
    );
  });

  it("atomically prepares one validated Platform-owned installation and safe release receipt",
    async () => {
      const fixture = await inputFixture();
      const inputs = await loadCoreSingleSitePrepareInputs(fixture.paths);
      const stateDirectory = join(fixture.directory, "state");
      const now = new Date().toISOString();

      const prepared = await prepareCoreSingleSiteState({ inputs, stateDirectory, now });

      const installationDirectory = join(
        stateDirectory,
        "installations",
        inputs.digests.installation,
      );
      const preparedDirectory = join(
        stateDirectory,
        "prepared",
        inputs.digests.prepareFacts,
      );
      expect(prepared).toEqual({
        receiptPath: join(preparedDirectory, "prepare-receipt.json"),
        digest: expect.stringMatching(/^[a-f0-9]{64}$/u),
      });
      const receiptText = await readFile(prepared.receiptPath, "utf8");
      const receipt = JSON.parse(receiptText) as Record<string, unknown>;
      expect(Object.keys(receipt).sort()).toEqual([
        "configDigest", "digest", "inputDigests", "installationDigest",
        "installationDirectory", "kind", "paths", "prepareFactsDigest",
        "preparedDirectory", "privateArtifactsManifestDigest", "runtimePathsDigest",
        "schemaVersion", "verifiedDeployment",
      ]);
      expect(receipt).toMatchObject({
        schemaVersion: 1,
        kind: "kokoro.core-single-site-prepare-receipt",
        installationDigest: inputs.digests.installation,
        prepareFactsDigest: inputs.digests.prepareFacts,
        installationDirectory: `installations/${inputs.digests.installation}`,
        preparedDirectory: `prepared/${inputs.digests.prepareFacts}`,
        inputDigests: {
          operatorConfig: inputs.digests.operatorConfig,
          webReport: inputs.digests.webReport,
          deploymentFacts: inputs.digests.deploymentFacts,
        },
        verifiedDeployment: {
          deploymentManifestDigest: inputs.deploymentFacts.deploymentManifestDigest,
          platformImage: inputs.deploymentFacts.platformImage,
          siteImage: inputs.deploymentFacts.siteImage,
        },
      });
      expect(prepared.digest).toBe(receipt.digest);
      expect((await stat(stateDirectory)).mode & 0o777).toBe(0o700);
      expect((await stat(installationDirectory)).mode & 0o777).toBe(0o700);
      expect((await stat(preparedDirectory)).mode & 0o777).toBe(0o700);
      expect((await stat(join(installationDirectory, "output"))).mode & 0o777).toBe(0o700);
      expect((await stat(prepared.receiptPath)).mode & 0o777).toBe(0o600);

      const paths = (receipt.paths as {
        installation: Record<string, string>;
        prepared: Record<string, string>;
      });
      expect(paths).toEqual({
        installation: {
          bootstrapDocument: "bootstrap/core-single-site.json",
          makerAttestation: "bootstrap/authorization/maker-attestation.json",
          makerPublicKey: "bootstrap/authorization/maker-public-key.pem",
          checkerAttestation: "bootstrap/authorization/checker-attestation.json",
          checkerPublicKey: "bootstrap/authorization/checker-public-key.pem",
          siteReleaseCertificationKeys:
            "secrets/platform-admin/site-release-certification-keys.json",
          ownerPassword: "secrets/platform-core-bootstrap/owner-password",
          redemptionEntropy: "secrets/platform-core-bootstrap/redemption-entropy",
          siteProviderRegistry: "secrets/platform-core-bootstrap/site-providers.json",
          authorizationEventKeys: "secrets/platform-api/authorization-event-keys.json",
          authorizationEventVerificationKeys:
            "secrets/platform-authorization/authorization-event-public.json",
          commerceRedemptionKeys: "secrets/platform-api/commerce-redemption-keys.json",
          identityPasswordPeppers: "secrets/platform-api/identity-password-peppers.json",
          identityAuditKey: "secrets/platform-api/identity-audit.key",
          privateArtifactsManifest: "private-artifacts.json",
          outputDirectory: "output",
        },
        prepared: { runtimeEnvironment: "runtime-paths.env" },
      });
      const artifactPath = (name: string) => join(installationDirectory, paths.installation[name]!);
      const documentText = await readFile(artifactPath("bootstrapDocument"), "utf8");
      const document = JSON.parse(documentText) as CoreSingleSiteBootstrapDocument;
      expect(document).toMatchObject({
        environment: inputs.deploymentFacts.environment,
        region: inputs.deploymentFacts.region,
        site: {
          siteId: inputs.webReport.siteId,
          siteKey: inputs.webReport.siteKey,
          siteReleaseRef: inputs.webReport.releaseId,
          webArtifactDigest: inputs.webReport.webArtifactDigest,
          releaseManifestDigest: inputs.digests.webReport,
          metadataEndpoint: CORE_SINGLE_SITE_METADATA_ENDPOINT,
        },
        model: inputs.operatorConfig.model,
        identity: { email: inputs.operatorConfig.ownerEmail },
      });
      expect(documentText).not.toContain(inputs.deploymentFacts.platformImage);
      expect(documentText).not.toContain(inputs.deploymentFacts.deploymentManifestDigest);
      expect(documentText).not.toContain(inputs.deploymentFacts.publicOrigin);

      const password = await readFile(artifactPath("ownerPassword"), "utf8");
      const entropy = await readFile(artifactPath("redemptionEntropy"));
      const certificationAuthority = new Ed25519SiteReleaseCertificationAuthority(
        parseSiteReleaseCertificationKeys(JSON.parse(
          await readFile(artifactPath("siteReleaseCertificationKeys"), "utf8"),
        )),
      );
      const makerBundle = parseCoreBootstrapAdminAttestationBundle(JSON.parse(
        await readFile(artifactPath("makerAttestation"), "utf8"),
      ));
      const checkerBundle = parseCoreBootstrapAdminAttestationBundle(JSON.parse(
        await readFile(artifactPath("checkerAttestation"), "utf8"),
      ));
      expect(makerBundle.attestations.map(({ operation }) => operation)).toEqual(
        CORE_SINGLE_SITE_BOOTSTRAP_MAKER_OPERATIONS,
      );
      expect(checkerBundle.attestations.map(({ operation }) => operation)).toEqual(
        CORE_SINGLE_SITE_BOOTSTRAP_CHECKER_OPERATIONS,
      );
      const execution = await prepareCoreSingleSiteBootstrapExecution({
        document,
        secretDigests: {
          password: sha(password),
          redemptionEntropy: createHash("sha256").update(entropy).digest("hex"),
        },
        makerAttestations: makerBundle,
        makerPublicKey: createPublicKey(await readFile(artifactPath("makerPublicKey"), "utf8")),
        checkerAttestations: checkerBundle,
        checkerPublicKey: createPublicKey(await readFile(artifactPath("checkerPublicKey"), "utf8")),
        certificationAuthority,
        now,
        environment: { PLATFORM_MODEL_GATEWAY_DIRECT_ENDPOINT: document.model.endpoint },
      });
      expect(receipt.configDigest).toBe(execution.configDigest);
      await assertFixedSiteProviderBinding(artifactPath("siteProviderRegistry"), {
        namespace: document.site.providerNamespace,
        metadataEndpoint: document.site.metadataEndpoint,
      });
      const signingKeys = await loadAuthorizationEventKeyRing(
        artifactPath("authorizationEventKeys"),
      );
      await createSessionAuthorizationEventSigner(signingKeys);
      const verificationKeys = await loadAuthorizationVerificationKeys(
        artifactPath("authorizationEventVerificationKeys"),
        "event_signing",
      );
      expect(verificationKeys).toEqual(signingKeys.keys.map((key) => ({
        purpose: "event_signing",
        keyRevision: key.keyRevision,
        publicKeyPem: key.publicKeyPem,
        current: key.current,
        notBefore: key.notBefore,
        notAfter: key.notAfter,
      })));
      expect(await readFile(artifactPath("authorizationEventVerificationKeys"), "utf8"))
        .not.toContain("privateKeyPem");
      await loadIdentityPasswordHasher(artifactPath("identityPasswordPeppers"));
      await loadIdentityAuditDigester(artifactPath("identityAuditKey"));
      await loadRedemptionSecretCodec(artifactPath("commerceRedemptionKeys"));

      const privateManifest = await readFile(
        artifactPath("privateArtifactsManifest"),
        "utf8",
      );
      const runtimePaths = await readFile(
        join(preparedDirectory, paths.prepared.runtimeEnvironment!),
        "utf8",
      );
      const safeOutput = `${receiptText}\n${privateManifest}\n${runtimePaths}\n${JSON.stringify(prepared)}`;
      expect(safeOutput).not.toContain(password);
      expect(safeOutput).not.toContain(entropy.toString("utf8"));
      expect(runtimePaths).toContain(`KOKORO_CORE_STATE_DIR='${installationDirectory}'`);
      expect(runtimePaths).toContain(
        `KOKORO_SITE_PUBLIC_ORIGIN='${inputs.deploymentFacts.publicOrigin}'`,
      );
      expect(runtimePaths).toContain(
        `PLATFORM_MODEL_GATEWAY_DIRECT_ENDPOINT='${inputs.operatorConfig.model.endpoint}'`,
      );
      const runtimeEnvironment = parseRuntimeEnvironment(runtimePaths);
      const expectedOperationIds = expectedCorePublicOperationIds();
      expect(runtimeEnvironment).toEqual({
        KOKORO_CORE_STATE_DIR: installationDirectory,
        KOKORO_ENVIRONMENT: inputs.deploymentFacts.environment,
        KOKORO_PLATFORM_IMAGE: inputs.deploymentFacts.platformImage,
        KOKORO_SITE_IMAGE: inputs.deploymentFacts.siteImage,
        KOKORO_SITE_DEPLOYMENT_REF: inputs.deploymentFacts.deploymentRef,
        KOKORO_SITE_RELEASE_REF: inputs.webReport.releaseId,
        KOKORO_WEB_ARTIFACT_DIGEST: inputs.webReport.webArtifactDigest,
        KOKORO_SITE_PUBLIC_ORIGIN: inputs.deploymentFacts.publicOrigin,
        PLATFORM_MODEL_GATEWAY_DIRECT_ENDPOINT: inputs.operatorConfig.model.endpoint,
        KOKORO_SITE_ID: document.site.siteId,
        KOKORO_SITE_KEY: document.site.siteKey,
        KOKORO_SITE_PROJECT_BINDING_REF: document.site.siteProjectBindingRef,
        KOKORO_SITE_WORKLOAD_IDENTITY_ID: document.site.workloadIdentityId,
        KOKORO_PRODUCT_AUDIENCE: document.site.audience,
        KOKORO_SESSION_CONTRACT_REVISION: document.site.sessionContractRevision,
        KOKORO_SITE_BINDING_EPOCH: "2",
        KOKORO_SITE_SECURITY_EPOCH: "1",
        KOKORO_SITE_POLICY_EPOCH: "2",
        KOKORO_PLATFORM_PUBLIC_OPERATION_IDS_JSON: JSON.stringify(expectedOperationIds),
      });
      expect(Object.keys(runtimeEnvironment)).toHaveLength(19);
      expect(receipt.runtimePathsDigest).toBe(sha(runtimePaths));

      const operationIds = JSON.parse(
        runtimeEnvironment.KOKORO_PLATFORM_PUBLIC_OPERATION_IDS_JSON!,
      ) as string[];
      expect(operationIds).toHaveLength(22);
      expect(operationIds).toEqual(expectedOperationIds);
      expect(operationIds).toEqual([...operationIds].sort((left, right) =>
        left.localeCompare(right, "en")));
      expect(new Set(operationIds).size).toBe(operationIds.length);
      expect(operationIds).toEqual(expect.arrayContaining([
        ...AUTHORIZATION_PUBLIC_OPERATION_IDS,
        "createIdentitySession",
        "completeSessionMfa",
        "reauthenticateIdentitySession",
        "beginTotpEnrollment",
        "confirmTotpEnrollment",
        "disableTotp",
        "regenerateRecoveryCodes",
        "refreshIdentitySession",
        "listIdentitySessions",
        "revokeIdentitySessions",
        "getPublicCommandReceipt",
        ...COMMERCE_PUBLIC_OPERATION_IDS,
      ]));
      for (const featureOffOperationId of [
        ...FEATURE_OFF_IDENTITY_OPERATION_IDS,
        ...ASSET_PUBLIC_OPERATION_IDS,
        ...ARTIFACT_PUBLIC_OPERATION_IDS,
        ...MEDIA_PUBLIC_OPERATION_IDS,
      ]) {
        expect(operationIds).not.toContain(featureOffOperationId);
      }
      expect(operationIds.some((operationId) => /memory/iu.test(operationId))).toBe(false);
    }, 30_000);

  it("reuses one installation without rotating any private artifact", async () => {
    const fixture = await inputFixture();
    const inputs = await loadCoreSingleSitePrepareInputs(fixture.paths);
    const stateDirectory = join(fixture.directory, "state");
    const first = await prepareCoreSingleSiteState({ inputs, stateDirectory });
    const installationDirectory = join(stateDirectory, "installations", inputs.digests.installation);
    const protectedPaths = [
      "private-artifacts.json",
      "bootstrap/core-single-site.json",
      "bootstrap/authorization/maker-public-key.pem",
      "bootstrap/authorization/checker-public-key.pem",
      "secrets/platform-api/authorization-event-keys.json",
      "secrets/platform-authorization/authorization-event-public.json",
      "secrets/platform-api/commerce-redemption-keys.json",
      "secrets/platform-api/identity-password-peppers.json",
      "secrets/platform-core-bootstrap/owner-password",
      "secrets/platform-core-bootstrap/redemption-entropy",
    ].map((path) => join(installationDirectory, path));
    const before = await Promise.all(protectedPaths.map(async (path) => ({
      path,
      bytes: await readFile(path),
      metadata: await stat(path, { bigint: true }),
    })));

    const second = await prepareCoreSingleSiteState({ inputs, stateDirectory });

    expect(second).toEqual(first);
    for (const expected of before) {
      expect(await readFile(expected.path)).toEqual(expected.bytes);
      const metadata = await stat(expected.path, { bigint: true });
      expect(metadata.ino).toBe(expected.metadata.ino);
      expect(metadata.mtimeNs).toBe(expected.metadata.mtimeNs);
    }
  }, 30_000);

  it("keeps the immutable runtime authorization key valid after the bootstrap ceremony window",
    async () => {
      const fixture = await inputFixture();
      const inputs = await loadCoreSingleSitePrepareInputs(fixture.paths);
      const stateDirectory = join(fixture.directory, "state");

      await prepareCoreSingleSiteState({
        inputs,
        stateDirectory,
        now: "2024-01-01T00:00:00.000Z",
      });

      const keyRing = JSON.parse(await readFile(join(
        stateDirectory,
        "installations",
        inputs.digests.installation,
        "secrets/platform-api/authorization-event-keys.json",
      ), "utf8")) as { keys: Array<{ notAfter: string }> };
      expect(keyRing.keys).toEqual([expect.objectContaining({
        notAfter: "9999-12-31T23:59:59.999Z",
      })]);
    }, 30_000);

  it.each([
    ["revision", (key: Record<string, unknown>) => ({
      ...key, keyRevision: "core-auth-other",
    })],
    ["public key", (key: Record<string, unknown>) => ({
      ...key, publicKeyPem: `${String(key.publicKeyPem)}\n`,
    })],
    ["current marker", (key: Record<string, unknown>) => ({ ...key, current: false })],
    ["not-before", (key: Record<string, unknown>) => ({
      ...key, notBefore: "2025-01-01T00:00:00.000Z",
    })],
    ["not-after", (key: Record<string, unknown>) => ({
      ...key, notAfter: "9998-12-31T23:59:59.999Z",
    })],
    ["private material", (key: Record<string, unknown>) => ({
      ...key, privateKeyPem: "forbidden",
    })],
  ] as const)("rejects a manifested authorization verification-key %s mismatch",
    async (_axis, mutate) => {
      const fixture = await inputFixture();
      const initial = await loadCoreSingleSitePrepareInputs(fixture.paths);
      const stateDirectory = join(fixture.directory, "state");
      await prepareCoreSingleSiteState({ inputs: initial, stateDirectory });
      const installation = join(stateDirectory, "installations", initial.digests.installation);
      const publicPath = join(
        installation,
        "secrets/platform-authorization/authorization-event-public.json",
      );
      const publicSet = JSON.parse(await readFile(publicPath, "utf8")) as {
        keys: Array<Record<string, unknown>>;
      };
      publicSet.keys[0] = mutate(publicSet.keys[0]!);
      const publicText = `${JSON.stringify(publicSet, null, 2)}\n`;
      await writeFile(publicPath, publicText, { mode: 0o600 });
      await chmod(publicPath, 0o600);
      await rewritePrivateManifest(installation, "authorizationEventVerificationKeys", publicText);
      await writePrivate(fixture.paths.deploymentFactsPath, {
        ...fixture.deploymentFacts,
        platformImage: `registry.example/kokoro/platform@sha256:${"9".repeat(64)}`,
      });
      const changedRelease = await loadCoreSingleSitePrepareInputs(fixture.paths);

      await expect(prepareCoreSingleSiteState({ inputs: changedRelease, stateDirectory }))
        .rejects.toThrow("CORE_SINGLE_SITE_PREPARE_INSTALLATION_CONFLICT");
    }, 30_000);

  it("binds a new release receipt to new Platform facts while reusing the installation", async () => {
    const fixture = await inputFixture();
    const originalInputs = await loadCoreSingleSitePrepareInputs(fixture.paths);
    const stateDirectory = join(fixture.directory, "state");
    const original = await prepareCoreSingleSiteState({
      inputs: originalInputs,
      stateDirectory,
    });
    const installationDirectory = join(
      stateDirectory,
      "installations",
      originalInputs.digests.installation,
    );
    const originalManifest = await readFile(join(installationDirectory, "private-artifacts.json"));
    const originalRuntimeEnvironment = parseRuntimeEnvironment(await readFile(
      join(dirname(original.receiptPath), "runtime-paths.env"),
      "utf8",
    ));
    const changedFacts = {
      ...fixture.deploymentFacts,
      deploymentManifestDigest: "8".repeat(64),
      platformImage: `registry.example/kokoro/platform@sha256:${"9".repeat(64)}`,
      publicOrigin: "https://new-core.example.com",
    } as const;
    await writePrivate(fixture.paths.deploymentFactsPath, changedFacts);
    const changedInputs = await loadCoreSingleSitePrepareInputs(fixture.paths);
    expect(changedInputs.digests.installation).toBe(originalInputs.digests.installation);
    expect(changedInputs.digests.prepareFacts).not.toBe(originalInputs.digests.prepareFacts);

    const changed = await prepareCoreSingleSiteState({ inputs: changedInputs, stateDirectory });

    expect(await readFile(join(installationDirectory, "private-artifacts.json")))
      .toEqual(originalManifest);
    const receipt = JSON.parse(await readFile(changed.receiptPath, "utf8")) as {
      verifiedDeployment: Record<string, string>;
    };
    expect(receipt.verifiedDeployment).toEqual({
      deploymentManifestDigest: changedFacts.deploymentManifestDigest,
      platformImage: changedFacts.platformImage,
      siteImage: changedFacts.siteImage,
    });
    const changedRuntimeText = await readFile(
      join(dirname(changed.receiptPath), "runtime-paths.env"),
      "utf8",
    );
    expect(changedRuntimeText).toContain(
      `KOKORO_SITE_PUBLIC_ORIGIN='${changedFacts.publicOrigin}'`,
    );
    const changedRuntimeEnvironment = parseRuntimeEnvironment(changedRuntimeText);
    expect(Object.keys(changedRuntimeEnvironment)).toHaveLength(19);
    for (const name of CORE_SAFE_FACT_ENVIRONMENT_NAMES) {
      expect(changedRuntimeEnvironment[name]).toBe(originalRuntimeEnvironment[name]);
    }
  }, 30_000);

  it("fails closed instead of rotating an installation after persistent configuration drift",
    async () => {
      const fixture = await inputFixture();
      const initial = await loadCoreSingleSitePrepareInputs(fixture.paths);
      const stateDirectory = join(fixture.directory, "state");
      await prepareCoreSingleSiteState({ inputs: initial, stateDirectory });
      await writePrivate(fixture.paths.operatorConfigPath, {
        schemaVersion: 1,
        ownerEmail: "other-owner@example.com",
        model: fixture.operatorConfig.model,
      });
      const changed = await loadCoreSingleSitePrepareInputs(fixture.paths);

      await expect(prepareCoreSingleSiteState({ inputs: changed, stateDirectory }))
        .rejects.toThrow("CORE_SINGLE_SITE_PREPARE_CONFIGURATION_CONFLICT");
      expect((await readdir(join(stateDirectory, "installations"))).sort()).toEqual([
        initial.digests.installation,
      ]);
    }, 30_000);

  it("fails closed on a corrupted private artifact without replacing it", async () => {
    const fixture = await inputFixture();
    const inputs = await loadCoreSingleSitePrepareInputs(fixture.paths);
    const stateDirectory = join(fixture.directory, "state");
    await prepareCoreSingleSiteState({ inputs, stateDirectory });
    const passwordPath = join(
      stateDirectory,
      "installations",
      inputs.digests.installation,
      "secrets/platform-core-bootstrap/owner-password",
    );
    await writeFile(passwordPath, "tampered-but-still-private", { mode: 0o600 });

    await expect(prepareCoreSingleSiteState({ inputs, stateDirectory }))
      .rejects.toThrow("CORE_SINGLE_SITE_PREPARE_INSTALLATION_CONFLICT");
    expect(await readFile(passwordPath, "utf8")).toBe("tampered-but-still-private");
  }, 30_000);

  it("converges concurrent prepares on one complete installation and receipt", async () => {
    const fixture = await inputFixture();
    const inputs = await loadCoreSingleSitePrepareInputs(fixture.paths);
    const stateDirectory = join(fixture.directory, "state");

    const results = await Promise.all([
      prepareCoreSingleSiteState({ inputs, stateDirectory }),
      prepareCoreSingleSiteState({ inputs, stateDirectory }),
    ]);

    expect(results[1]).toEqual(results[0]);
    expect((await readdir(join(stateDirectory, "installations"))).sort()).toEqual([
      inputs.digests.installation,
    ]);
    expect((await readdir(join(stateDirectory, "prepared"))).sort()).toEqual([
      inputs.digests.prepareFacts,
    ]);
    expect((await readdir(stateDirectory)).some((name) => name.includes(".tmp"))).toBe(false);
  }, 30_000);

  it("atomically claims one installation identity before concurrent private generation", async () => {
    const firstFixture = await inputFixture();
    const first = await loadCoreSingleSitePrepareInputs(firstFixture.paths);
    await writePrivate(firstFixture.paths.operatorConfigPath, {
      ...firstFixture.operatorConfig,
      ownerEmail: "second-owner@example.com",
    });
    const second = await loadCoreSingleSitePrepareInputs(firstFixture.paths);
    const stateDirectory = join(firstFixture.directory, "state");

    const outcomes = await Promise.allSettled([
      prepareCoreSingleSiteState({ inputs: first, stateDirectory }),
      prepareCoreSingleSiteState({ inputs: second, stateDirectory }),
    ]);

    expect(outcomes.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter(({ status }) => status === "rejected")).toHaveLength(1);
    const installations = (await readdir(join(stateDirectory, "installations"))).sort();
    expect(installations).toHaveLength(1);
    expect([first.digests.installation, second.digests.installation]).toContain(installations[0]);
  }, 30_000);

  it("canonicalizes operator formatting for installation identity while binding raw release facts",
    async () => {
      const fixture = await inputFixture();
      const original = await loadCoreSingleSitePrepareInputs(fixture.paths);
      await writeFile(
        fixture.paths.operatorConfigPath,
        `${JSON.stringify(fixture.operatorConfig, null, 2)}\n`,
        { mode: 0o600 },
      );
      const reformatted = await loadCoreSingleSitePrepareInputs(fixture.paths);

      expect(reformatted.digests.operatorConfig).not.toBe(original.digests.operatorConfig);
      expect(reformatted.digests.installation).toBe(original.digests.installation);
      expect(reformatted.digests.prepareFacts).not.toBe(original.digests.prepareFacts);
    });

  it("rejects an unmanifested file outside the mutable output directory", async () => {
    const fixture = await inputFixture();
    const inputs = await loadCoreSingleSitePrepareInputs(fixture.paths);
    const stateDirectory = join(fixture.directory, "state");
    await prepareCoreSingleSiteState({ inputs, stateDirectory });
    const installationDirectory = join(stateDirectory, "installations", inputs.digests.installation);
    const unexpected = join(installationDirectory, "secrets/platform-api/unexpected.key");
    await writeFile(unexpected, "unmanifested", { mode: 0o600 });

    await expect(prepareCoreSingleSiteState({ inputs, stateDirectory }))
      .rejects.toThrow("CORE_SINGLE_SITE_PREPARE_INSTALLATION_CONFLICT");
    expect(await readFile(unexpected, "utf8")).toBe("unmanifested");
  }, 30_000);

  it("prints one safe receipt locator and no generated secret", async () => {
    const fixture = await inputFixture();
    const stateDirectory = join(fixture.directory, "state");
    const stdout: string[] = [];

    const result = await runCoreSingleSitePrepareMain({
      argv: [
        "--operator-config", fixture.paths.operatorConfigPath,
        "--web-report", fixture.paths.webReportPath,
        "--deployment-facts", fixture.paths.deploymentFactsPath,
        "--state-directory", stateDirectory,
      ],
      writeStdout: (value) => stdout.push(value),
    });

    expect(stdout).toEqual([`${JSON.stringify(result)}\n`]);
    expect(Object.keys(result).sort()).toEqual(["digest", "receiptPath"]);
    const installation = join(
      stateDirectory,
      "installations",
      (await loadCoreSingleSitePrepareInputs(fixture.paths)).digests.installation,
    );
    for (const relativePath of [
      "secrets/platform-core-bootstrap/owner-password",
      "secrets/platform-core-bootstrap/redemption-entropy",
      "secrets/platform-api/identity-audit.key",
    ]) {
      expect(stdout.join(""))
        .not.toContain(await readFile(join(installation, relativePath), "utf8"));
    }
  }, 30_000);

  it.each([
    ["operator", "operatorConfigPath", "CORE_SINGLE_SITE_PREPARE_OPERATOR_CONFIG_INVALID"],
    ["Web report", "webReportPath", "CORE_SINGLE_SITE_PREPARE_WEB_REPORT_INVALID"],
    ["deployment facts", "deploymentFactsPath", "CORE_SINGLE_SITE_PREPARE_DEPLOYMENT_FACTS_INVALID"],
  ] as const)("rejects an unknown field in the strict %s input",
    async (_kind, pathName, code) => {
      const fixture = await inputFixture();
      const path = fixture.paths[pathName];
      const source = JSON.parse(pathName === "operatorConfigPath" ? fixture.operatorText :
        pathName === "webReportPath" ? fixture.webReportText : fixture.deploymentFactsText) as
        Record<string, unknown>;
      await writePrivate(path, { ...source, unexpected: true });

      await expect(loadCoreSingleSitePrepareInputs(fixture.paths)).rejects.toThrow(code);
    });

  type DeploymentFacts = Awaited<ReturnType<typeof inputFixture>>["deploymentFacts"];

  async function inputFixture() {
    const directory = await mkdtemp(join(tmpdir(), "core-single-site-prepare-input-"));
    temporaryDirectories.push(directory);
    await chmod(directory, 0o700);
    const operatorConfig = {
      schemaVersion: 1,
      ownerEmail: "owner@example.com",
      model: {
        endpoint: "https://direct-model.internal/v1",
        modelKey: "gpt-5.4-mini",
      },
    } as const;
    const webReport = {
      schemaVersion: 1,
      kind: "kokoro.core-site-release",
      webCommit: "a".repeat(40),
      siteId: "site:core",
      siteKey: "core-site",
      releaseId: "core.2026.08.11.001",
      finalSourceClosureSha256: "b".repeat(64),
      lockSha256: "c".repeat(64),
      packageArtifacts: {
        "@kokoro/site-app-kit": { version: "1.0.0", sha256: "1".repeat(64) },
      },
      routes: ["/", "/account", "/api/release/metadata", "/login"],
      platform: "linux/amd64",
      image: `registry.example/kokoro/core@sha256:${"d".repeat(64)}`,
      webArtifactDigest: "d".repeat(64),
    } as const;
    const operatorConfigPath = join(directory, "operator.json");
    const webReportPath = join(directory, "web-report.json");
    const deploymentFactsPath = join(directory, "deployment-facts.json");
    const operatorText = await writePrivate(operatorConfigPath, operatorConfig);
    const webReportText = await writePrivate(webReportPath, webReport);
    const deploymentFacts = {
      schemaVersion: 1,
      kind: "kokoro.core-single-site-deployment-facts",
      environment: "production",
      region: "us-east-1",
      deploymentRef: "deployment:core:1",
      deploymentManifestDigest: "f".repeat(64),
      webReportDigest: sha(webReportText),
      platformImage: `registry.example/kokoro/platform@sha256:${"e".repeat(64)}`,
      siteImage: webReport.image,
      webArtifactDigest: webReport.webArtifactDigest,
      publicOrigin: "https://core.example.com",
      metadataEndpoint: CORE_SINGLE_SITE_METADATA_ENDPOINT,
    } as const;
    const deploymentFactsText = await writePrivate(deploymentFactsPath, deploymentFacts);
    return {
      directory,
      paths: { operatorConfigPath, webReportPath, deploymentFactsPath },
      operatorText,
      webReportText,
      deploymentFactsText,
      deploymentFacts,
      operatorConfig,
    };
  }
});

async function writePrivate(path: string, value: unknown): Promise<string> {
  const text = `${JSON.stringify(value)}\n`;
  await writeFile(path, text, { mode: 0o600 });
  await chmod(path, 0o600);
  return text;
}

function sha(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function expectedCorePublicOperationIds(): string[] {
  return [...new Set<string>([
    ...AUTHORIZATION_PUBLIC_OPERATION_IDS,
    ...IDENTITY_LAUNCH_OPERATION_IDS.filter((operationId) =>
      !FEATURE_OFF_IDENTITY_OPERATION_ID_SET.has(operationId)),
    ...COMMERCE_PUBLIC_OPERATION_IDS,
  ])].sort((left, right) => left.localeCompare(right, "en"));
}

function parseRuntimeEnvironment(source: string): Record<string, string> {
  if (!source.endsWith("\n")) throw new Error("runtime environment must end with newline");
  const environment: Record<string, string> = {};
  for (const line of source.slice(0, -1).split("\n")) {
    const separator = line.indexOf("=");
    const name = line.slice(0, separator);
    const encoded = line.slice(separator + 1);
    if (separator <= 0 || !/^[A-Z][A-Z0-9_]*$/u.test(name) ||
        !encoded.startsWith("'") || !encoded.endsWith("'") ||
        Object.hasOwn(environment, name)) {
      throw new Error("invalid runtime environment fixture");
    }
    const value = encoded.slice(1, -1).replaceAll(`'"'"'`, "'");
    if (`'${value.replaceAll("'", `'"'"'`)}'` !== encoded) {
      throw new Error("invalid runtime environment fixture");
    }
    environment[name] = value;
  }
  return environment;
}

async function rewritePrivateManifest(
  installation: string,
  artifactName: string,
  content: string,
): Promise<void> {
  const path = join(installation, "private-artifacts.json");
  const manifest = JSON.parse(await readFile(path, "utf8")) as {
    digest: string;
    artifacts: Array<{ name: string; sha256: string; bytes: number }>;
    [key: string]: unknown;
  };
  const artifact = manifest.artifacts.find(({ name }) => name === artifactName);
  if (artifact === undefined) throw new Error("missing fixture artifact");
  artifact.sha256 = sha(content);
  artifact.bytes = Buffer.byteLength(content);
  const { digest: _digest, ...body } = manifest;
  manifest.digest = createHash("sha256")
    .update("kokoro.core-single-site-prepare.private-artifacts.v1", "utf8")
    .update("\0", "utf8")
    .update(canonicalJson(body), "utf8")
    .digest("hex");
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right, "en"))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
