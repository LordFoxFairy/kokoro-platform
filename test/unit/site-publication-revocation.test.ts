import { describe, expect, it, vi } from "vitest";
import { SitePublicationAuthorityService } from
  "../../src/modules/site/application/services/site-publication-authority-service.js";
import { revokeSiteReleaseCandidateAuthorization } from
  "../../src/modules/site/domain/site-publication-authority.js";
import { PostgresSitePublicationAuthorityRepository } from
  "../../src/modules/site/infrastructure/postgres/site-publication-authority-repository.js";
import type { VerifiedRequestSecurityContext } from
  "../../src/shared/security-context/index.js";
import { issuePlatformTransaction, revokePlatformTransaction } from
  "../../src/shared/unit-of-work/platform-transaction.js";

const originalBinding = Object.freeze({
  ref: "candidate:alpha:7",
  version: 7n,
  authorizationEpoch: 3n,
  digest: `sha256:${"a".repeat(64)}`,
});
const authorized = Object.freeze({
  binding: originalBinding,
  siteRef: "site:alpha",
  environment: "production" as const,
  launchProductProfile: Object.freeze({ ref: "profile:1", revision: 1n,
    digest: `sha256:${"b".repeat(64)}` }),
  productSurfaceCatalog: Object.freeze({ ref: "catalog:1", revision: 1n,
    digest: `sha256:${"c".repeat(64)}` }),
  businessBindingsDigest: `sha256:${"d".repeat(64)}`,
  state: "authorized" as const,
  document: Object.freeze({}),
  canonicalBytes: new Uint8Array([123, 125]),
});

describe("Site release candidate revocation", () => {
  it("advances the authorization epoch exactly once and persists the same command transaction", async () => {
    const revokeCandidate = vi.fn(async () => undefined);
    const succeed = vi.fn(async () => undefined);
    const owner = service({
      current: authorized,
      disposition: "fresh",
      revokeCandidate,
      succeed,
    });

    await expect(owner.revokeCandidate(command(), context())).resolves.toEqual({
      candidate: { ...originalBinding, authorizationEpoch: 4n },
      previousAuthorizationEpoch: 3n,
      authorizationEpoch: 4n,
      state: "revoked",
      replayed: false,
    });
    expect(revokeCandidate).toHaveBeenCalledWith(expect.anything(), {
      candidate: originalBinding,
      expectedAuthorizationEpoch: 3n,
      authorizationEpoch: 4n,
      commandId: "01983f57-8cf1-7000-8000-000000000071",
    });
    expect(succeed).toHaveBeenCalledTimes(1);
  });

  it("replays the persisted terminal epoch without issuing a second mutation", async () => {
    const revoked = revokeSiteReleaseCandidateAuthorization(authorized, originalBinding, 3n).candidate;
    const revokeCandidate = vi.fn(async () => undefined);
    const succeed = vi.fn(async () => undefined);
    const owner = service({ current: revoked, disposition: "replay", revokeCandidate, succeed });

    await expect(owner.revokeCandidate(command(), context())).resolves.toMatchObject({
      authorizationEpoch: 4n,
      state: "revoked",
      replayed: true,
    });
    expect(revokeCandidate).not.toHaveBeenCalled();
    expect(succeed).not.toHaveBeenCalled();
  });

  it("rejects stale bindings and already-revoked fresh commands", async () => {
    expect(() => revokeSiteReleaseCandidateAuthorization(
      authorized,
      { ...originalBinding, digest: `sha256:${"e".repeat(64)}` },
      3n,
    )).toThrow("SITE_PUBLICATION_CANDIDATE_REVOKE_BINDING_MISMATCH");
    const revoked = revokeSiteReleaseCandidateAuthorization(authorized, originalBinding, 3n).candidate;
    const owner = service({ current: revoked, disposition: "fresh" });
    await expect(owner.revokeCandidate(command(), context()))
      .rejects.toThrow("SITE_PUBLICATION_CANDIDATE_ALREADY_REVOKED");
  });

  it("persists revocation as one exact state-and-epoch compare-and-swap", async () => {
    const executions: Array<{ statement: string; values: readonly unknown[] | undefined }> = [];
    const lease = issuePlatformTransaction({
      query: async () => [],
      execute: async (statement, values) => {
        executions.push({ statement, values });
        return 1;
      },
    });
    try {
      await new PostgresSitePublicationAuthorityRepository().revokeCandidate(lease.transaction, {
        candidate: originalBinding,
        expectedAuthorizationEpoch: 3n,
        authorizationEpoch: 4n,
        commandId: "01983f57-8cf1-7000-8000-000000000071",
      });
    } finally {
      revokePlatformTransaction(lease);
    }
    expect(executions).toHaveLength(1);
    expect(executions[0]?.statement).toContain("authorization_epoch=$1::numeric(20,0),state='revoked'");
    expect(executions[0]?.statement).toContain("AND state='authorized'");
    expect(executions[0]?.values).toEqual([
      "4", "01983f57-8cf1-7000-8000-000000000071", "candidate:alpha:7", "7",
      `sha256:${"a".repeat(64)}`, "3",
    ]);
  });

  it("maps a lost authorization compare-and-swap to a stable conflict", async () => {
    const lease = issuePlatformTransaction({ query: async () => [], execute: async () => 0 });
    try {
      await expect(new PostgresSitePublicationAuthorityRepository().revokeCandidate(
        lease.transaction,
        { candidate: originalBinding, expectedAuthorizationEpoch: 3n, authorizationEpoch: 4n,
          commandId: "01983f57-8cf1-7000-8000-000000000071" },
      )).rejects.toThrow("SITE_PUBLICATION_CANDIDATE_REVOKE_CONFLICT");
    } finally {
      revokePlatformTransaction(lease);
    }
  });
});

function service(input: Readonly<{
  current: typeof authorized | ReturnType<typeof revokeSiteReleaseCandidateAuthorization>["candidate"];
  disposition: "fresh" | "replay";
  revokeCandidate?: ReturnType<typeof vi.fn>;
  succeed?: ReturnType<typeof vi.fn>;
}>) {
  const unitOfWork = {
    execute: async (_fence: unknown, work: (transaction: unknown) => Promise<unknown>) => work({}),
  };
  const repository = {
    loadCandidateForUpdate: async () => input.current,
    revokeCandidate: input.revokeCandidate ?? vi.fn(async () => undefined),
  };
  const journal = {
    begin: async () => input.disposition,
    succeed: input.succeed ?? vi.fn(async () => undefined),
  };
  return new SitePublicationAuthorityService(
    unitOfWork as never,
    repository as never,
    journal as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
}

function command() {
  return Object.freeze({
    commandId: "01983f57-8cf1-7000-8000-000000000071",
    idempotencyKey: "candidate-revoke-alpha-0001",
    siteRef: "site:alpha",
    candidate: originalBinding,
    expectedAuthorizationEpoch: 3n,
    reason: "revoke compromised candidate",
  });
}

function context() {
  return Object.freeze({
    trustedCaller: Object.freeze({ kind: "admin_workload", workloadIdentityId: "admin:1" }),
    actor: Object.freeze({ kind: "operator", subjectId: "operator:1" }),
    target: Object.freeze({ siteId: "site:alpha" }),
    environment: "production",
    region: "us-east-1",
  }) as VerifiedRequestSecurityContext;
}
