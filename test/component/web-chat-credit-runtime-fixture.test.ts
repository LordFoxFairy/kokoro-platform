import { execFileSync } from "node:child_process";
import { createHash, verify, X509Certificate } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { UsageSettlementService } from
  "../../src/modules/credit/application/usage-settlement-service.js";
import type { UsageSettlementRepository } from
  "../../src/modules/credit/application/contracts/usage-settlement-repository.js";
import { ModelGatewayService, type ModelGatewayRequest } from
  "../../src/modules/model-gateway/application/model-gateway-service.js";
import { DirectOpenAiChatAdapter } from
  "../../src/modules/model-gateway/infrastructure/http/openai-compatible-chat-adapter.js";
import { createPlatformPublicProductionComposition } from
  "../../src/process/platform-public-composition.js";
import { PLATFORM_API_RUNTIME_CONTRACT } from
  "../../src/process/platform-api-runtime-contract.js";
import {
  fulfillmentOutputDigest,
  fulfillmentOutputSetDigest,
} from "../../src/modules/commerce/domain/canonical-fulfillment.js";
import {
  PLATFORM_FIXTURE_API_RUNTIME_FILE_FIELDS,
  PLATFORM_FIXTURE_MODEL_USAGE_LIMITS,
  createPlatformFixtureApiRuntimeAuthority,
  createPlatformFixtureModel,
  createPlatformFixtureObservation,
  createPlatformFixturePreparedResult,
  createPlatformFixtureSetupResult,
  createPlatformFixtureAuthorizationEventAuthority,
  createPlatformFixtureSessionAccessAuthority,
  parsePlatformFixtureCommand,
  verifyPlatformFixtureRedemptionLineage,
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
  it("funds the representative DeepAgents maximum through the production Direct adapter", async () => {
    const providerFetch = vi.fn(async () => new Response());
    const adapter = new DirectOpenAiChatAdapter({
      endpoint: "https://provider.fixture.invalid/v1",
      apiKey: "fixture-provider-key",
      fetch: providerFetch,
    });
    const prepared = adapter.prepare(representativeDeepAgentsRequest(), modelAuthorization());
    const maximumInput = dimension(prepared.maximumDimensions, "input_tokens");
    const maximumOutput = dimension(prepared.maximumDimensions, "output_tokens");
    const maximumRatedAmount = maximumInput + maximumOutput;

    expect(maximumInput).toBeGreaterThanOrEqual(30_213n);
    expect(maximumInput).toBeLessThanOrEqual(PLATFORM_FIXTURE_MODEL_USAGE_LIMITS.maximumInputUnits);
    expect(maximumOutput).toBe(65_536n);
    expect(maximumOutput).toBe(PLATFORM_FIXTURE_MODEL_USAGE_LIMITS.maximumOutputUnits);
    expect(PLATFORM_FIXTURE_MODEL_USAGE_LIMITS.maximumRatedAmount).toBe(
      PLATFORM_FIXTURE_MODEL_USAGE_LIMITS.maximumInputUnits +
      PLATFORM_FIXTURE_MODEL_USAGE_LIMITS.maximumOutputUnits,
    );
    expect(maximumRatedAmount).toBeLessThanOrEqual(
      PLATFORM_FIXTURE_MODEL_USAGE_LIMITS.maximumRatedAmount,
    );
    expect(PLATFORM_FIXTURE_MODEL_USAGE_LIMITS.segmentMaximum)
      .toBeGreaterThanOrEqual(PLATFORM_FIXTURE_MODEL_USAGE_LIMITS.maximumRatedAmount);
    expect(PLATFORM_FIXTURE_MODEL_USAGE_LIMITS.rootCeiling)
      .toBeGreaterThanOrEqual(PLATFORM_FIXTURE_MODEL_USAGE_LIMITS.segmentMaximum);
    expect(PLATFORM_FIXTURE_MODEL_USAGE_LIMITS.initialGrantAmount)
      .toBeGreaterThanOrEqual(PLATFORM_FIXTURE_MODEL_USAGE_LIMITS.rootCeiling);
    expect(PLATFORM_FIXTURE_MODEL_USAGE_LIMITS.initialGrantAmount).toBe(1_000_000n);
    expect(providerFetch).not.toHaveBeenCalled();
    const gatewayAttemptPersist = vi.fn(async (_transaction, input) => ({
      kind: "accepted" as const,
      value: input.receipt,
    }));
    const gatewayUsage = new UsageSettlementService({
      repository: usageRepositoryWithSegmentMaximum(
        PLATFORM_FIXTURE_MODEL_USAGE_LIMITS.segmentMaximum,
        gatewayAttemptPersist,
      ),
    });
    const persistAccepted = vi.fn(async (_transaction, record) => record);
    const gateway = modelGatewayFixture({
      provider: adapter,
      usage: gatewayUsage,
      persistAccepted,
    });
    const stream = gateway.stream(
      gatewayStreamInput(representativeDeepAgentsRequest()),
    )[Symbol.asyncIterator]();
    await expect(stream.next()).resolves.toMatchObject({
      done: false,
      value: { sequence: 1n, payload: { kind: "accepted" } },
    });
    await stream.return?.();
    expect(gatewayAttemptPersist).toHaveBeenCalledOnce();
    expect(persistAccepted).toHaveBeenCalledOnce();
    expect(providerFetch).not.toHaveBeenCalled();
    expect(fixtureSource).toContain(
      "rootCeiling: PLATFORM_FIXTURE_MODEL_USAGE_LIMITS.rootCeiling.toString()",
    );
    expect(fixtureSource).toContain(
      "segmentMaximum: PLATFORM_FIXTURE_MODEL_USAGE_LIMITS.segmentMaximum.toString()",
    );
    expect(fixtureSource.match(
      /amount: PLATFORM_FIXTURE_MODEL_USAGE_LIMITS\.initialGrantAmount\.toString\(\)/gu,
    )).toHaveLength(2);
  });

  it("fails before invocation/provider when the old 500-unit segment receives that request", async () => {
    const providerFetch = vi.fn(async () => new Response());
    const provider = new DirectOpenAiChatAdapter({
      endpoint: "https://provider.fixture.invalid/v1",
      apiKey: "fixture-provider-key",
      fetch: providerFetch,
    });
    const request = representativeDeepAgentsRequest();
    const authorization = modelAuthorization();
    const prepared = provider.prepare(request, authorization);
    const persistAttemptIntent = vi.fn();
    const usageRepository = usageRepositoryWithSegmentMaximum(500n, persistAttemptIntent);
    const usage = new UsageSettlementService({ repository: usageRepository });
    const usageOutcome = await usage.prepareAttempt({} as never, usageAttemptInput(
      prepared.maximumDimensions,
    ));
    expect(usageOutcome).toEqual({
      kind: "invalid_state",
      code: "CREDIT_USAGE_ATTEMPT_CAPACITY_EXCEEDED",
    });
    expect(persistAttemptIntent).not.toHaveBeenCalled();

    const persistAccepted = vi.fn();
    const gateway = modelGatewayFixture({
      provider,
      usage,
      persistAccepted,
    });
    const stream = gateway.stream(gatewayStreamInput(request))[Symbol.asyncIterator]();
    await expect(stream.next()).rejects.toThrow("MODEL_GATEWAY_USAGE_PREPARE_INVALID_STATE");
    expect(persistAccepted).not.toHaveBeenCalled();
    expect(providerFetch).not.toHaveBeenCalled();
  });

  it("fails closed when future input, output, or rating mutations exceed the attempt budget", async () => {
    const provider = new DirectOpenAiChatAdapter({
      endpoint: "https://provider.fixture.invalid/v1",
      apiKey: "fixture-provider-key",
      fetch: async () => new Response(),
    });
    const baseline = representativeDeepAgentsRequest();
    const mutations = [
      { name: "input", request: withSystemPromptGrowth(baseline, 65_536), rate: 1n },
      { name: "output", request: { ...baseline, maxOutputTokens: 131_072 }, rate: 1n },
      { name: "rating", request: baseline, rate: 2n },
    ] as const;
    for (const mutation of mutations) {
      const prepared = provider.prepare(mutation.request, modelAuthorization());
      const persistAttemptIntent = vi.fn();
      const usage = new UsageSettlementService({
        repository: usageRepositoryWithSegmentMaximum(
          PLATFORM_FIXTURE_MODEL_USAGE_LIMITS.segmentMaximum,
          persistAttemptIntent,
          mutation.rate,
        ),
      });
      await expect(usage.prepareAttempt({} as never, usageAttemptInput(prepared.maximumDimensions)),
        mutation.name).resolves.toEqual({
        kind: "invalid_state",
        code: "CREDIT_USAGE_ATTEMPT_CAPACITY_EXCEEDED",
      });
      expect(persistAttemptIntent, mutation.name).not.toHaveBeenCalled();
    }
  });

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
      redemptionCodeFile: "/private/runtime/redemption-code",
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
      redemptionCodeFile: "/private/runtime/redemption-code",
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
      claimedRedemptionCodeCount: 1,
      redemptionCount: 1,
      redemptionFulfillmentCount: 1,
      redemptionGrantCount: 1,
      providerEffectOnce: true,
      evidenceChainFinalized: true,
      creditSettledOnce: true,
      replayStable: true,
      availableConsumedDeltaEqual: true,
      redemptionFulfilledOnce: true,
      redemptionReplayStable: true,
      redemptionProductSourceVerified: true,
      redemptionGrantSourceVerified: true,
    });
    expect(result).toEqual({ schemaVersion: 1, kind: "platform-web-chat-credit-runtime-observation",
      providerInvocationCount: 1, providerAttemptCount: 1, finalizedEvidenceCount: 1,
      segmentSettlementCount: 1, captureJournalCount: 1, providerEffectOnce: true,
      claimedRedemptionCodeCount: 1, redemptionCount: 1, redemptionFulfillmentCount: 1,
      redemptionGrantCount: 1,
      evidenceChainFinalized: true, creditSettledOnce: true, replayStable: true,
      availableConsumedDeltaEqual: true, redemptionFulfilledOnce: true,
      redemptionReplayStable: true, redemptionProductSourceVerified: true,
      redemptionGrantSourceVerified: true });
    expect(Object.keys(result).some((key) =>
      ["ref", "payload", "content", "amount", "balance", "credential", "token", "secret"]
        .includes(key.toLowerCase()))).toBe(false);
    expect(() => createPlatformFixtureObservation({ ...result, providerInvocationCount: -1 }))
      .toThrow("PLATFORM_FIXTURE_OBSERVATION_INVALID");
  });

  it("derives redemption product and Grant source evidence from one exact joined lineage", () => {
    const output = {
      kind: "credit_grant" as const,
      outputLineId: "credits",
      outputOrdinal: 1,
      occurrence: 1,
      outputRef: "10000000-0000-4000-8000-000000000004",
      templateRevisionRef: "credit-program:runtime:1",
      outputVersion: 1 as const,
    };
    const outputDigest = fulfillmentOutputDigest(output);
    const lineage = {
      redemptionId: "10000000-0000-4000-8000-000000000001",
      codeRef: "10000000-0000-4000-8000-000000000002",
      redemptionState: "fulfilled",
      redemptionProductVersionRef: "product:runtime:1",
      redemptionFulfillmentRef: "10000000-0000-4000-8000-000000000003",
      redemptionBillingAccountRef: "billing:runtime",
      fulfillmentId: "10000000-0000-4000-8000-000000000003",
      fulfillmentState: "committed",
      fulfillmentSourceType: "redemption",
      fulfillmentSourceRef: "10000000-0000-4000-8000-000000000002",
      fulfillmentProductVersionRef: "product:runtime:1",
      fulfillmentOutputSetDigest: fulfillmentOutputSetDigest([{ ...output, outputDigest }]),
      fulfillmentBillingAccountRef: "billing:runtime",
      fulfillmentIdempotencyKey: "a".repeat(64),
      outputKind: "credit_grant",
      outputLineId: output.outputLineId,
      outputOrdinal: output.outputOrdinal,
      occurrence: output.occurrence,
      outputRef: output.outputRef,
      templateRevisionRef: output.templateRevisionRef,
      outputVersion: output.outputVersion,
      outputDigest,
      grantId: output.outputRef,
      grantBillingAccountRef: "billing:runtime",
      grantSourceType: "redemption",
      grantSourceRef: `${"a".repeat(64)}:credits:1`,
      grantCreditProgramRevisionRef: output.templateRevisionRef,
    };

    expect(verifyPlatformFixtureRedemptionLineage([lineage])).toEqual({
      redemptionProductSourceVerified: true,
      redemptionGrantSourceVerified: true,
    });
    for (const mutation of [
      { fulfillmentSourceRef: "10000000-0000-4000-8000-000000000099" },
      { fulfillmentProductVersionRef: "product:wrong:1" },
      { fulfillmentOutputSetDigest: "b".repeat(64) },
    ]) {
      expect(verifyPlatformFixtureRedemptionLineage([{ ...lineage, ...mutation }])).toEqual({
        redemptionProductSourceVerified: false,
        redemptionGrantSourceVerified: false,
      });
    }
    for (const mutation of [
      { grantSourceRef: `${"a".repeat(64)}:wrong:1` },
      { grantBillingAccountRef: "billing:wrong" },
    ]) {
      expect(verifyPlatformFixtureRedemptionLineage([{ ...lineage, ...mutation }])).toEqual({
        redemptionProductSourceVerified: true,
        redemptionGrantSourceVerified: false,
      });
    }
    for (const clause of [
      "fulfillment.source_id=redemption.code_ref::text",
      "fulfillment.product_version_ref=redemption.product_version_ref",
      "actual.output_kind='credit_grant'",
      "grant_fact.billing_account_ref=fulfillment.billing_account_ref",
      "grant_fact.source_type='redemption'",
      "grant_fact.credit_program_revision_ref=actual.template_revision",
      '"commerce_fulfillment_actual_output"',
    ]) expect(fixtureSource).toContain(clause);
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
    expect(fixtureSource).toContain("createCommerceAdministrationComposition");
    expect(fixtureSource).toContain("production.commerce.publishCreditProgramRevision");
    expect(fixtureSource).toContain("production.commerce.publishOffer");
    expect(fixtureSource).toContain("production.commerce.publishProgram");
    expect(fixtureSource).toContain("production.commerce.issueBatch");
    expect(fixtureSource).toContain("production.commerce.approveBatch");
    expect(fixtureSource).toContain("production.commerce.activateBatch");
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
          "previewRedemption",
          "confirmRedemption",
          "recoverRedemptionCommand",
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

function representativeDeepAgentsRequest(): ModelGatewayRequest {
  const tools = Array.from({ length: 15 }, (_, toolIndex) => ({
    name: `deep_agent_tool_${toolIndex}`,
    description: `Representative DeepAgents tool ${toolIndex}. ${"bounded description ".repeat(18)}`,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: Object.fromEntries(Array.from({ length: 12 }, (_, propertyIndex) => [
        `argument_${propertyIndex}`,
        {
          type: "string",
          description: `Bounded argument ${propertyIndex}. ${"schema guidance ".repeat(8)}`,
        },
      ])),
      required: ["argument_0"],
    },
  }));
  return Object.freeze({
    protocol: "openai.chat.completions.v1",
    model: "chat-primary",
    messages: Object.freeze([
      Object.freeze({
        role: "system" as const,
        content: `Representative DeepAgents system policy. ${"bounded orchestration policy ".repeat(420)}`,
        toolCalls: Object.freeze([]),
      }),
      Object.freeze({ role: "user" as const, content: "Complete the bounded fixture turn.",
        toolCalls: Object.freeze([]) }),
    ]),
    maxOutputTokens: 65_536,
    tools: Object.freeze(tools),
    toolChoice: "auto",
  });
}

function withSystemPromptGrowth(request: ModelGatewayRequest, bytes: number): ModelGatewayRequest {
  const [system, ...remaining] = request.messages;
  if (system === undefined || system.role !== "system") {
    throw new Error("PLATFORM_FIXTURE_MODEL_SYSTEM_PROMPT_MISSING");
  }
  return Object.freeze({
    ...request,
    messages: Object.freeze([
      Object.freeze({ ...system, content: `${system.content}${"x".repeat(bytes)}` }),
      ...remaining,
    ]),
  });
}

function modelAuthorization() {
  return Object.freeze({
    modelAuthorizationHandle: `model-authorization:sha256:${"a".repeat(64)}`,
    siteId: "site:web-chat-credit-runtime",
    executionManifestRef: "execution-manifest:fixture",
    authorizationSegmentRef: "authorization-segment:fixture",
    authorizedGatewayModel: "chat-primary",
    providerModel: "provider-chat-fixture",
    adapterKind: "direct" as const,
    expiresAt: "2099-01-01T00:00:00.000Z",
  });
}

function dimension(
  dimensions: readonly Readonly<{ dimensionKey: string; quantity: bigint }>[],
  key: string,
): bigint {
  const value = dimensions.find(({ dimensionKey }) => dimensionKey === key)?.quantity;
  if (value === undefined) throw new Error("PLATFORM_FIXTURE_MODEL_DIMENSION_MISSING");
  return value;
}

function usageRepositoryWithSegmentMaximum(
  maximumAmount: bigint,
  persistAttemptIntent: ReturnType<typeof vi.fn>,
  rate = 1n,
): UsageSettlementRepository {
  const context = {
    siteId: "site:web-chat-credit-runtime",
    billingAccountId: "billing:fixture",
    creditAccountId: "credit-account:fixture",
    unit: "credit_micros",
    liabilityMerchantAccountId: "merchant:fixture",
    ratingPolicyRevisionRef: "rating-policy:fixture",
    executionBudgetRootRef: "budget-root:fixture",
    executionBudgetRootState: "open",
    executionBudgetRootVersion: 1n,
    creditHoldRef: "credit-hold:fixture",
    creditHoldState: "open",
    creditHoldFenceEpoch: 1n,
    budgetAllocationRef: "budget-allocation:fixture",
    authorizationSegmentRef: "authorization-segment:fixture",
    executionManifestRef: "execution-manifest:fixture",
    expiresAt: "2099-01-01T00:00:00.000Z",
    consumptionScope: { surfaceRef: "chat", capabilityKey: "model.chat", agentRef: null },
    ratingSnapshotRef: null,
    allocation: {
      revision: 2n,
      allocationEpoch: 1n,
      creditCeiling: maximumAmount,
      unassignedStock: 0n,
      activeChildReservedStock: 0n,
      committedStock: maximumAmount,
      capturedCumulative: 0n,
      returnedToParentCumulative: 0n,
      state: "active",
    },
    segment: {
      state: "committed",
      maximumAmount,
      allocationEpoch: 1n,
      preparedAgainstAllocationRevision: 1n,
      committedFromAllocationRevision: 1n,
      committedToAllocationRevision: 2n,
      aggregateVersion: 2n,
      fenceEpoch: 2n,
      resolutionKind: null,
      resolutionRef: null,
      committedAt: "2026-08-09T00:00:00.000Z",
      settledAt: null,
      releasedAt: null,
    },
    ratingPolicy: {
      ratingPolicyRevisionRef: "rating-policy:fixture",
      customerUnit: "credit_micros",
      chargeableAttemptOutcomes: ["succeeded", "failed_after_effect"],
      minimumAmount: 0n,
      rules: [
        { dimensionKey: "input_tokens", sourceUnit: "token", quantum: 1n,
          amountPerQuantum: rate, required: true },
        { dimensionKey: "output_tokens", sourceUnit: "token", quantum: 1n,
          amountPerQuantum: rate, required: true },
      ],
    },
  };
  return {
    findCommandReceipt: async () => ({ kind: "none" }),
    lockUsageContext: async () => context,
    loadCommittedAttemptMaximum: async () => 0n,
    persistAttemptIntent,
  } as unknown as UsageSettlementRepository;
}

function modelGatewayFixture(input: Readonly<{
  provider: DirectOpenAiChatAdapter;
  usage: UsageSettlementService;
  persistAccepted: ReturnType<typeof vi.fn>;
}>): ModelGatewayService {
  const authorization = modelAuthorization();
  return new ModelGatewayService({
    unitOfWork: {
      scanDispatchCandidates: async () => [],
      execute: async (_scope, work) => work({} as never, authorization),
    },
    repository: {
      lockInvocation: async () => null,
      persistTerminal: async () => undefined,
      persistOutcomeUnknown: async () => undefined,
    },
    provider: input.provider,
    usageOwner: input.usage,
    streamingRepository: {
      reserveCapacity: async () => undefined,
      persistAccepted: input.persistAccepted,
      claimInvocation: async () => null,
      listFrames: async (_transaction: unknown, { record }: Readonly<{
        record: Readonly<{ invocationRef: string; attemptRef: string }>;
      }>) => [{
        invocationRef: record.invocationRef,
        attemptRef: record.attemptRef,
        sequence: 1n,
        previousFrameDigest: "0".repeat(64),
        frameDigest: "1".repeat(64),
        payload: { kind: "accepted" as const },
      }],
    } as never,
    clock: () => new Date("2026-08-09T00:00:00.000Z"),
    reference: () => "fixture-reference",
  });
}

function gatewayStreamInput(request: ModelGatewayRequest) {
  const authorization = modelAuthorization();
  return Object.freeze({
    modelAuthorizationHandle: authorization.modelAuthorizationHandle,
    logicalCallRef: "logical-call:fixture",
    attemptRef: "attempt:fixture",
    producerContext: "ga-run:fixture",
    producerGeneration: 1n,
    request,
    afterSequence: 0n,
    signal: new AbortController().signal,
  });
}

function usageAttemptInput(maximumDimensions: readonly Readonly<{
  dimensionKey: string;
  sourceUnit: string;
  quantity: bigint;
}>[]) {
  return Object.freeze({
    siteId: "site:web-chat-credit-runtime",
    authorizationSegmentRef: "authorization-segment:fixture",
    executionManifestRef: "execution-manifest:fixture",
    producerKind: "model_gateway" as const,
    producerContext: "ga-run:fixture",
    producerGeneration: 1n,
    attemptRef: "attempt:fixture",
    logicalEffectRef: "logical-call:fixture",
    maximumDimensions,
    businessOperationKey: "model-gateway:prepare:fixture",
    requestDigest: "b".repeat(64),
  });
}

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
