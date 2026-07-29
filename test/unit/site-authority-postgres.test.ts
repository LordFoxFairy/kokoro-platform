import { describe, expect, it } from "vitest";
import { PostgresSiteAuthorityJournal } from "../../src/modules/site/infrastructure/postgres/site-authority-journal.js";
import { PostgresSiteAuthorityRepository } from "../../src/modules/site/infrastructure/postgres/site-authority-repository.js";
import type { ActivationAttempt, SiteAggregate, SiteRelease } from "../../src/modules/site/domain/site-lifecycle.js";
import { issuePlatformTransaction, revokePlatformTransaction } from "../../src/shared/unit-of-work/platform-transaction.js";

const site: SiteAggregate = Object.freeze({
  siteRef: "site_01", state: "active", activeReleaseRef: "release_02",
  securityEpoch: 2n, policyEpoch: 6n, revocationEpoch: 1n,
  runtimeBindingEpoch: 4n,
});
const release: SiteRelease = Object.freeze({
  releaseRef: "release_02", siteRef: "site_01", state: "active",
  webArtifactDigest: "a".repeat(64), releaseManifestDigest: "b".repeat(64),
  certificationDigest: "c".repeat(64),
});
const attempt: ActivationAttempt = Object.freeze({
  attemptRef: "activation_02", siteRef: "site_01", candidateReleaseRef: "release_02",
  expectedActiveReleaseRef: "release_01", candidateWebArtifactDigest: "a".repeat(64),
  candidateManifestDigest: "b".repeat(64), candidateCertificationDigest: "c".repeat(64),
  siteProjectBindingRef: "binding_01", siteProjectBindingEpoch: 1n,
  runtimeBindingEpoch: 4n,
  environment: "production", region: "us-east-1", audience: "site-product",
  sessionContractRevision: "browser-v3",
  state: "draining", requestedAt: "2026-07-28T12:00:00.000Z",
  providerOperationKey: "provider-operation-activation-02", deploymentRef: "deployment_02",
  observedAt: "2026-07-28T12:01:00.000Z", failureCode: null,
});

describe("Postgres Site authority", () => {
  it("creates the Site and independent project binding atomically through the caller transaction", async () => {
    const calls: { statement: string; values: readonly unknown[] }[] = [];
    const lease = issuePlatformTransaction({ query: async () => [], execute: async (statement, values = []) => {
      calls.push({ statement, values }); return 1;
    } });
    try {
      await new PostgresSiteAuthorityRepository().insertSiteWithProjectBinding(lease.transaction,
        { ...site, siteKey: "image-studio", state: "preview_ready", activeReleaseRef: null },
        { bindingRef: "binding_01", siteRef: "site_01", repositoryRef: "github:org/image-studio",
          providerNamespace: "vercel", providerProjectRef: "image-studio", environment: "production",
          region: "us-east-1",
          workloadIdentityId: "spiffe://kokoro/site/image-studio", bindingEpoch: 1n, state: "active" });
      expect(calls).toHaveLength(2);
      expect(calls[0]?.statement).toContain("INSERT INTO platform.site");
      expect(calls[1]?.statement).toContain("INSERT INTO platform.site_project_binding");
    } finally { revokePlatformTransaction(lease); }
  });

  it("persists the complete immutable release snapshot", async () => {
    const calls: { statement: string; values: readonly unknown[] }[] = [];
    const lease = issuePlatformTransaction({ query: async () => [], execute: async (statement, values = []) => {
      calls.push({ statement, values }); return 1;
    } });
    try {
      await new PostgresSiteAuthorityRepository().insertRelease(lease.transaction, {
        ...release, state: "ready", launchProfileRef: "core-redeem-chat@1",
        siteConfigRevisionRef: "config_01", legalRevisionRef: "legal_01",
        featurePolicyRevision: "policy_01", modelOptionCatalogRef: "models_01",
        agentCatalogRef: "agents_01", identityIssuerLabel: "Image Studio",
        identityAuthStrengthPolicyRevision: "auth_policy_01", enabledSurfaceIds: ["account", "chat"],
        localePolicy: { defaultLocale: "en-US", allowedLocales: ["en-US"] },
      });
      expect(calls).toHaveLength(1);
      expect(calls[0]?.statement).toContain("certification_digest");
      expect(calls[0]?.statement).toContain("identity_auth_strength_policy_revision");
      expect(calls[0]?.values).toContain(JSON.stringify(["account", "chat"]));
    } finally { revokePlatformTransaction(lease); }
  });

  it("loads owner rows under lock and rejects malformed persisted state", async () => {
    const calls: string[] = [];
    const lease = issuePlatformTransaction({
      query: async <Row extends Record<string, unknown>>(statement: string) => {
        calls.push(statement);
        return [{ siteRef: "site_01", state: "active", activeReleaseRef: "release_01",
          securityEpoch: 2n, policyEpoch: 5n, revocationEpoch: 1n,
          runtimeBindingEpoch: 3n }] as unknown as readonly Row[];
      },
      execute: async () => 0,
    });
    try {
      const loaded = await new PostgresSiteAuthorityRepository().loadSiteForUpdate(lease.transaction, "site_01");
      expect(loaded?.activeReleaseRef).toBe("release_01");
      expect(calls[0]).toContain("FOR UPDATE");
      expect(calls[0]).toContain("platform.site");
    } finally { revokePlatformTransaction(lease); }
  });

  it("reserves a strictly monotonic runtime binding epoch under the owner lock", async () => {
    const calls: { statement: string; values: readonly unknown[] }[] = [];
    const lease = issuePlatformTransaction({
      query: async <Row extends Record<string, unknown>>(statement: string, values = []) => {
        calls.push({ statement, values });
        return [{ runtimeBindingEpoch: 5n }] as unknown as readonly Row[];
      },
      execute: async () => 0,
    });
    try {
      await expect(new PostgresSiteAuthorityRepository().reserveRuntimeBindingEpoch(
        lease.transaction, "site_01", 4n,
      )).resolves.toBe(5n);
      expect(calls[0]?.statement).toContain("runtime_binding_epoch=runtime_binding_epoch+1");
      expect(calls[0]?.statement).toContain("runtime_binding_epoch=$2");
    } finally { revokePlatformTransaction(lease); }
  });

  it("commits candidate, pointer, draining release and attempt under an exact pointer CAS", async () => {
    const calls: { statement: string; values: readonly unknown[] }[] = [];
    const lease = issuePlatformTransaction({
      query: async () => [],
      execute: async (statement, values = []) => {
        calls.push({ statement, values });
        return 1;
      },
    });
    try {
      await new PostgresSiteAuthorityRepository().commitActivation(lease.transaction, {
        site, candidate: release, attempt,
        expectedActiveReleaseRef: "release_01", drainingReleaseRef: "release_01",
      });
      expect(calls.length).toBeGreaterThanOrEqual(10);
      expect(calls[0]?.statement).toContain("site_deployment_binding");
      expect(calls[0]?.statement).toContain("state='draining'");
      expect(calls[1]?.statement).toContain("site_deployment_binding");
      expect(calls[1]?.statement).toContain("state='active'");
      const statements = calls.map(({ statement }) => statement).join("\n");
      expect(statements).toContain("active_release_ref IS NOT DISTINCT FROM $3");
      expect(calls.some(({ values }) => values.includes("release_01"))).toBe(true);
      expect(statements).toContain("platform.authorization_site");
      expect(statements).toContain("platform.authorization_site_release");
      expect(statements).toContain("platform.authorization_product_binding");
      expect(statements).toContain("binding_epoch < EXCLUDED.binding_epoch");
      expect(statements).toContain("site_activation_attempt");
    } finally { revokePlatformTransaction(lease); }
  });

  it("records provider evidence and its exact candidate deployment in the owner transaction", async () => {
    const calls: { statement: string; values: readonly unknown[] }[] = [];
    const lease = issuePlatformTransaction({
      query: async () => [],
      execute: async (statement, values = []) => { calls.push({ statement, values }); return 1; },
    });
    try {
      await new PostgresSiteAuthorityRepository().recordObservationAndCandidateDeployment(
        lease.transaction,
        { observationRef: "01983f57-8cf1-7000-8000-000000000002", attemptRef: "activation_02",
          providerOperationKey: "provider-operation-activation-02", deploymentRef: "deployment_02",
          releaseRef: "release_02", webArtifactDigest: "a".repeat(64), healthy: true,
          trafficReady: true, observedAt: "2026-07-28T12:01:00.000Z", payloadDigest: "d".repeat(64) },
        { deploymentRef: "deployment_02", bindingRef: "binding_01", siteRef: "site_01",
          releaseRef: "release_02", environment: "production", region: "us-east-1",
          audience: "site-product", sessionContractRevision: "browser-v3",
          webArtifactDigest: "a".repeat(64), bindingEpoch: 3n, state: "candidate" },
      );
      expect(calls).toHaveLength(2);
      expect(calls[0]?.statement).toContain("site_deployment_observation");
      expect(calls[1]?.statement).toContain("site_deployment_binding");
      expect(calls[1]?.statement).toContain("ON CONFLICT (deployment_ref) DO NOTHING");
    } finally { revokePlatformTransaction(lease); }
  });

  it("atomically revokes the drained deployment, retires its release, and completes activation", async () => {
    const statements: string[] = [];
    const lease = issuePlatformTransaction({ query: async () => [], execute: async (statement) => {
      statements.push(statement); return 1;
    } });
    try {
      await new PostgresSiteAuthorityRepository().recordDrainObservationAndComplete(
        lease.transaction,
        { observationRef: "01983f57-8cf1-7000-8000-000000000003", attemptRef: "activation_02",
          providerOperationKey: "provider-drain-operation-01", deploymentRef: "deployment_01",
          releaseRef: "release_01", webArtifactDigest: "f".repeat(64), healthy: false,
          trafficReady: false, observedAt: "2026-07-28T12:03:00.000Z", payloadDigest: "e".repeat(64) },
        { ...attempt, state: "succeeded" },
      );
      expect(statements).toHaveLength(4);
      expect(statements[0]).toContain("site_deployment_observation");
      expect(statements[1]).toContain("state='revoked'");
      expect(statements[2]).toContain("state='retired'");
      expect(statements[3]).toContain("state='succeeded'");
    } finally { revokePlatformTransaction(lease); }
  });

  it("atomically fences authorization before a provider traffic-stop effect", async () => {
    const statements: string[] = [];
    const lease = issuePlatformTransaction({ query: async () => [], execute: async (statement) => {
      statements.push(statement); return 1;
    } });
    try {
      await new PostgresSiteAuthorityRepository().beginTrafficStop(
        lease.transaction,
        { ...site, state: "suspending" },
        {
          attemptRef: "traffic_stop_01", siteRef: "site_01", action: "suspend",
          releaseRef: "release_02", deploymentRef: "deployment_02", bindingRef: "binding_01",
          runtimeBindingEpoch: 4n, providerNamespace: "vercel", environment: "production",
          region: "us-east-1", state: "requested", requestedAt: "2026-07-29T13:00:00.000Z",
          providerOperationKey: null, observedAt: null, failureCode: null,
        },
      );
      expect(statements.join("\n")).toContain("platform.site_traffic_stop_attempt");
      expect(statements.join("\n")).toContain("platform.authorization_site");
      expect(statements.join("\n")).toContain("platform.authorization_product_binding");
      expect(statements.join("\n")).toContain("state='draining'");
    } finally { revokePlatformTransaction(lease); }
  });

  it("does not continue after an active pointer CAS loses", async () => {
    let executions = 0;
    const lease = issuePlatformTransaction({
      query: async () => [],
      execute: async () => { executions += 1; return executions < 3 ? 1 : 0; },
    });
    try {
      await expect(new PostgresSiteAuthorityRepository().commitActivation(lease.transaction, {
        site, candidate: release, attempt,
        expectedActiveReleaseRef: "release_01", drainingReleaseRef: "release_01",
      })).rejects.toThrow("SITE_ACTIVE_POINTER_CONFLICT");
      expect(executions).toBeGreaterThanOrEqual(3);
    } finally { revokePlatformTransaction(lease); }
  });

  it("writes the Site receipt and event through the caller transaction", async () => {
    const calls: { kind: string; transaction: unknown; value: unknown }[] = [];
    const journal = new PostgresSiteAuthorityJournal({
      begin: async (transaction, value) => {
        calls.push({ kind: "begin", transaction, value });
        return { ...value, state: "pending", result: null, resultDigest: null };
      },
      recordOutcome: async (transaction, _identity, value) => {
        calls.push({ kind: "outcome", transaction, value });
        return value as never;
      },
    }, {
      enqueue: async (transaction, value) => { calls.push({ kind: "outbox", transaction, value }); },
    });
    const lease = issuePlatformTransaction({ query: async () => [], execute: async () => 0 });
    try {
      const command = {
        commandId: "01983f57-8cf1-7000-8000-000000000001", idempotencyKey: "activation-command-01",
        operation: "site.activation.begin", siteRef: "site_01", callerIdentity: "admin-01",
        environment: "production", region: "us-east-1", requestDigest: "d".repeat(64),
      } as const;
      await expect(journal.begin(lease.transaction, command)).resolves.toBe("fresh");
      await journal.succeed(lease.transaction, command,
        { attemptRef: "activation_02", state: "preparing", replayed: false },
        { requestId: "request-01", correlationId: "correlation-01" } as never);
      expect(calls.map(({ kind }) => kind)).toEqual(["begin", "outbox", "outcome"]);
      expect(calls.every(({ transaction }) => transaction === lease.transaction)).toBe(true);
      expect(calls[1]?.value).toMatchObject({ owner: "site", eventType: "site.activation.begin.v1",
        aggregateId: "site_01", correlationId: "correlation-01", causationId: "request-01" });
    } finally { revokePlatformTransaction(lease); }
  });
});
