import { describe, expect, it } from "vitest";
import { queryString } from "./api";

describe("queryString", () => {
  it("encodes resource route and selected siteId deterministically", () => {
    expect(
      queryString({
        moduleId: "payment",
        route: "/admin/payments/plans",
        siteId: "site-demo",
      }),
    ).toBe("moduleId=payment&route=%2Fadmin%2Fpayments%2Fplans&siteId=site-demo");
  });
});
