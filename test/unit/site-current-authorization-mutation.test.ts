import { describe, expect, it } from "vitest";
import { SiteCurrentAuthorizationMutation } from
  "../../src/modules/site/application/services/site-current-authorization-mutation.js";

describe("SiteCurrentAuthorizationMutation", () => {
  it("reserves global/Site sequence before mutating the exact owner and leaves its neighbor valid", async () => {
    const calls: string[] = [];
    const states = new Map([['site-target', 'active'], ['site-neighbor', 'active']]);
    const publisher = {
      reserveSiteMutation: async (_transaction: unknown, input: { siteRef: string }) => {
        calls.push(`reserve:${input.siteRef}`);
        return { siteRef: input.siteRef, streamSequence: 1n, aggregateSequence: 1n };
      },
      publishSiteCurrent: async (_transaction: unknown, input: { current: { siteRef: string; state: string } }) => {
        calls.push(`publish:${input.current.siteRef}:${input.current.state}`);
      },
    };
    const reader = {
      loadSiteCurrent: async (_transaction: unknown, siteRef: string) => {
        calls.push(`read:${siteRef}`);
        return {
          siteRef, state: states.get(siteRef)!, siteSecurityEpoch: "2", policyEpoch: "1",
          revocationEpoch: "2", updatedAt: "2026-07-29T13:00:00.000Z",
          retainUntil: "2026-07-29T13:05:00.000Z",
        } as const;
      },
    };
    const mutation = new SiteCurrentAuthorizationMutation(publisher as never, reader as never);

    await mutation.execute({} as never, {
      siteRef: "site-target", correlationId: "correlation-01",
    }, async () => {
      calls.push("mutate:site-target");
      states.set("site-target", "suspended");
    });

    expect(calls).toEqual([
      "reserve:site-target", "mutate:site-target", "read:site-target", "publish:site-target:suspended",
    ]);
    expect(states.get("site-neighbor")).toBe("active");
  });
});
