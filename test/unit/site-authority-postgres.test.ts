import { describe, expect, it } from "vitest";
import { PostgresSiteAuthorityJournal } from "../../src/modules/site/infrastructure/postgres/site-authority-journal.js";
import { PostgresSiteAuthorityRepository } from "../../src/modules/site/infrastructure/postgres/site-authority-repository.js";
import type { ActivationAttempt, SiteAggregate, SiteRelease } from "../../src/modules/site/domain/site-lifecycle.js";
import { issuePlatformTransaction, revokePlatformTransaction } from "../../src/shared/unit-of-work/platform-transaction.js";

const site: SiteAggregate = Object.freeze({
  siteRef: "site_01", state: "active", activeReleaseRef: "release_02",
  securityEpoch: 2n, policyEpoch: 6n, revocationEpoch: 1n,
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
  state: "draining", requestedAt: "2026-07-28T12:00:00.000Z",
  providerOperationKey: "provider-operation-activation-02", deploymentRef: "deployment_02",
  observedAt: "2026-07-28T12:01:00.000Z",
});

describe("Postgres Site authority", () => {
  it("loads owner rows under lock and rejects malformed persisted state", async () => {
    const calls: string[] = [];
    const lease = issuePlatformTransaction({
      query: async <Row extends Record<string, unknown>>(statement: string) => {
        calls.push(statement);
        return [{ siteRef: "site_01", state: "active", activeReleaseRef: "release_01",
          securityEpoch: 2n, policyEpoch: 5n, revocationEpoch: 1n }] as unknown as readonly Row[];
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
      expect(calls).toHaveLength(4);
      expect(calls[0]?.statement).toContain("active_release_ref IS NOT DISTINCT FROM $3");
      expect(calls[0]?.values).toContain("release_01");
      expect(calls[1]?.statement).toContain("site_release");
      expect(calls[2]?.statement).toContain("site_release");
      expect(calls[3]?.statement).toContain("site_activation_attempt");
    } finally { revokePlatformTransaction(lease); }
  });

  it("does not continue after an active pointer CAS loses", async () => {
    let executions = 0;
    const lease = issuePlatformTransaction({
      query: async () => [],
      execute: async () => { executions += 1; return 0; },
    });
    try {
      await expect(new PostgresSiteAuthorityRepository().commitActivation(lease.transaction, {
        site, candidate: release, attempt,
        expectedActiveReleaseRef: "release_01", drainingReleaseRef: "release_01",
      })).rejects.toThrow("SITE_ACTIVE_POINTER_CONFLICT");
      expect(executions).toBe(1);
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
