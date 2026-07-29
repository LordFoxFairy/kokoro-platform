import { describe, expect, it } from "vitest";
import { issuePlatformTransaction } from "../../src/shared/unit-of-work/platform-transaction.js";
import type { ScopedSessionAuthorizationMutationPort } from "../../src/modules/authorization/application/contracts/scoped-session-authorization-port.js";
import { IdentitySessionAuthorizationMutation } from "../../src/modules/identity/application/services/identity-session-authorization-mutation.js";

const current = Object.freeze({
  siteRef: "site-1",
  subjectRef: "subject-1",
  identitySessionRef: "session-1",
  state: "revoked" as const,
  identitySessionEpoch: "2",
  credentialEpoch: "2",
  expiresAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-07-29T00:00:00.000Z",
  retainUntil: "2026-09-01T00:00:00.000Z",
});

describe("Identity session scoped authorization mutation", () => {
  it("reserves global and Site sequence before touching the exact owner, then publishes in the same UoW", async () => {
    const order: string[] = [];
    const port: ScopedSessionAuthorizationMutationPort = {
      async reserveIdentitySessionMutation() {
        order.push("global-site-reserved");
        return { siteRef: "site-1", streamSequence: 7n, aggregateSequence: 3n };
      },
      async publishIdentitySessionCurrent(_transaction, input) {
        order.push(`published:${input.current.identitySessionRef}`);
      },
    };
    const transaction = issuePlatformTransaction({
      async query() { return []; },
      async execute() { return 0; },
    }).transaction;

    const result = await new IdentitySessionAuthorizationMutation(port).execute(
      transaction,
      { siteRef: "site-1", correlationId: "correlation-1" },
      async () => {
        order.push("owner-mutated");
        return current;
      },
    );

    expect(result).toEqual(current);
    expect(order).toEqual([
      "global-site-reserved",
      "owner-mutated",
      "published:session-1",
    ]);
  });

  it("rejects a current fact outside the reserved Site", async () => {
    let published = false;
    const port: ScopedSessionAuthorizationMutationPort = {
      async reserveIdentitySessionMutation() {
        return { siteRef: "site-1", streamSequence: 7n, aggregateSequence: 3n };
      },
      async publishIdentitySessionCurrent() { published = true; },
    };
    const transaction = issuePlatformTransaction({
      async query() { return []; },
      async execute() { return 0; },
    }).transaction;

    await expect(new IdentitySessionAuthorizationMutation(port).execute(
      transaction,
      { siteRef: "site-1", correlationId: "correlation-1" },
      async () => ({ ...current, siteRef: "site-2" }),
    )).rejects.toThrow("SCOPED_AUTHORIZATION_OWNER_MISMATCH");
    expect(published).toBe(false);
  });
});
