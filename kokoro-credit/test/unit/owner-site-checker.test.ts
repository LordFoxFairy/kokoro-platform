import { describe, expect, it } from "vitest";
import { HttpOwnerSiteChecker } from "../../src/infrastructure/http/owner-site-checker.js";
import type { CreditAccount } from "../../src/domain/credit.js";

const account: CreditAccount = {
  id: "a1",
  siteId: "s1",
  ownerKind: "user",
  ownerId: "u1",
  status: "active",
  balanceMicros: "0",
  heldMicros: "0",
  deletedAt: null,
  deletedBy: null,
  deleteReason: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

function fetchReturning(activeFor: (url: string) => boolean): typeof fetch {
  return async (url) =>
    new Response(JSON.stringify({ data: { active: activeFor(String(url)) } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
}

describe("HttpOwnerSiteChecker", () => {
  it("passes when both site and owner are active", async () => {
    const checker = new HttpOwnerSiteChecker("http://user", "http://site", "sec", fetchReturning(() => true));
    await expect(checker.ensureAccountActive(account)).resolves.toBeUndefined();
  });

  it("throws site.suspended when the site is inactive", async () => {
    const checker = new HttpOwnerSiteChecker(
      "http://user",
      "http://site",
      "sec",
      fetchReturning((url) => !url.includes("/sites/")),
    );
    await expect(checker.ensureAccountActive(account)).rejects.toMatchObject({
      code: "site.suspended",
      httpStatus: 409,
    });
  });

  it("throws owner.inactive when the owner is inactive", async () => {
    const checker = new HttpOwnerSiteChecker(
      "http://user",
      "http://site",
      "sec",
      fetchReturning((url) => url.includes("/sites/")),
    );
    await expect(checker.ensureAccountActive(account)).rejects.toMatchObject({
      code: "owner.inactive",
      httpStatus: 409,
    });
  });
});
