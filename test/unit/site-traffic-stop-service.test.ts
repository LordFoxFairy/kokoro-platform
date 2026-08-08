import { describe, expect, it } from "vitest";
import { SiteTrafficStopService } from "../../src/modules/site/application/services/site-traffic-stop-service.js";
import type { SiteTrafficStopRepository } from "../../src/modules/site/application/contracts/site-traffic-stop-ports.js";
import type { SiteAuthorityJournal } from "../../src/modules/site/application/contracts/site-authority-ports.js";
import { PlatformUnitOfWork } from "../../src/shared/unit-of-work/unit-of-work.js";
import { issuePlatformTransaction, revokePlatformTransaction } from "../../src/shared/unit-of-work/platform-transaction.js";
import { verifyRequestSecurityContext } from "../../src/shared/security-context/request-security-context.js";

describe("SiteTrafficStopService", () => {
  it("persists the admission fence, stop intent, receipt and outbox in one owner transaction", async () => {
    const calls: string[] = [];
    const repository: SiteTrafficStopRepository = {
      loadSiteForUpdate: async () => ({
        siteRef: "site_01", state: "active", activeReleaseRef: "release_01",
        securityEpoch: 4n, policyEpoch: 7n, revocationEpoch: 3n, runtimeBindingEpoch: 8n,
      }),
      loadActiveDeploymentForUpdate: async () => ({
        deploymentRef: "deployment_01", bindingRef: "binding_01", siteRef: "site_01",
        releaseRef: "release_01", environment: "production", region: "us-east-1",
        audience: "site-product", sessionContractRevision: "browser-v3",
        webArtifactDigest: "a".repeat(64), bindingEpoch: 8n, state: "active",
        providerNamespace: "vercel",
      }),
      loadTrafficStopForUpdate: async () => null,
      beginTrafficStop: async (_transaction, owner, attempt) => {
        calls.push(`fence:${owner.state}:${attempt.state}`);
      },
      updateTrafficStop: async () => undefined,
      recordTrafficStopObservation: async () => undefined,
    };
    const journal: SiteAuthorityJournal = {
      begin: async () => { calls.push("begin"); return "fresh"; },
      succeed: async () => { calls.push("succeed"); },
    };
    const service = new SiteTrafficStopService(unitOfWork({
      siteRef: "site_01", state: "active", activeReleaseRef: "release_01",
      securityEpoch: 4n, policyEpoch: 7n, revocationEpoch: 3n, runtimeBindingEpoch: 8n,
    }), repository, journal, { now: () => "2026-07-29T13:00:00.000Z",
      approvalAuthority: { consume: async () => { calls.push("approval"); } },
      authorization: { async execute(_transaction: unknown, _input: unknown, mutate: () => Promise<void>) {
        calls.push("authorization");
        await mutate();
        return {};
      } } as never });

    await expect(service.requestTrafficStop({
      commandId: "01983f57-8cf1-7000-8000-000000000021",
      idempotencyKey: "site-traffic-stop-command-01", attemptRef: "traffic_stop_01",
      approvalRef: "10000000-0000-4000-8000-000000000001",
      siteRef: "site_01", action: "suspend", reason: "security incident",
    }, await context("site.traffic-stop.request", "admin_workload"))).resolves.toEqual({
      attemptRef: "traffic_stop_01", state: "requested", replayed: false,
    });
    expect(calls).toEqual(["begin", "approval", "authorization", "fence:suspending:requested", "succeed"]);
  });
});

function unitOfWork(site: Record<string, unknown>): PlatformUnitOfWork {
  return new PlatformUnitOfWork({
    async transaction(_fence, work) {
      const lease = issuePlatformTransaction({
        query: async <Row extends Record<string, unknown>>(statement: string) =>
          statement.includes("FROM platform.site ") ? [site] as unknown as readonly Row[] : [],
        execute: async () => 1,
      });
      try { return await work(lease.transaction); } finally { revokePlatformTransaction(lease); }
    },
  }, () => "2026-07-29T13:00:30.000Z");
}

async function context(operation: string, kind: "admin_workload" | "platform_worker") {
  const issuer = "spiffe://kokoro.test";
  return verifyRequestSecurityContext({
    requestId: "request-01", correlationId: "correlation-01",
    trustedCaller: { kind, workloadIdentityId: `${kind}-01`, environment: "production",
      region: "us-east-1", audience: "platform-admin", allowedOperations: [operation], bindingEpoch: "1",
      issuedAt: "2026-07-29T13:00:00.000Z", expiresAt: "2026-07-29T13:10:00.000Z" },
    actor: { kind: kind === "admin_workload" ? "operator" : "workload", subjectId: "actor-01",
      subjectGeneration: "1" }, delegatedGrant: null,
    target: { siteId: "site_01", workspaceId: null, projectId: null, purpose: operation, scopes: [operation] },
    audience: "platform-admin", environment: "production", region: "us-east-1",
    evidence: [{ kind: "workload_attestation", evidenceId: "attestation-01", issuer }], policyEpoch: "1",
    issuedAt: "2026-07-29T13:00:00.000Z", expiresAt: "2026-07-29T13:10:00.000Z",
  }, { now: "2026-07-29T13:00:30.000Z", operation, expectedAudience: "platform-admin",
    expectedEnvironment: "production", expectedRegion: "us-east-1", callerVerifier: { verify: async () => ({
      workloadIdentityId: `${kind}-01`, kind, audience: "platform-admin", environment: "production",
      region: "us-east-1", allowedOperations: [operation], siteId: null, bindingEpoch: "1",
      issuedAt: "2026-07-29T13:00:00.000Z", expiresAt: "2026-07-29T13:10:00.000Z",
      issuer, keyVersion: "test-1",
    }) } });
}
