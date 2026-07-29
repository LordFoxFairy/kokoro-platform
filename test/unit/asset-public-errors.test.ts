import { describe, expect, it } from "vitest";
import { platformPublicSafeProblem } from "../../src/interfaces/http/platform-public.js";
import { AssetApplicationError } from "../../src/modules/asset/application/asset-application-error.js";

describe("Asset public problem mapping", () => {
  it.each([
    ["ASSET_NOT_ACCEPTED", 404, "never"],
    ["ASSET_UPLOAD_CONFLICT", 409, "never"],
    ["ASSET_QUOTA_EXCEEDED", 422, "after_user_action"],
    ["ASSET_TEMPORARILY_UNAVAILABLE", 503, "after_delay"],
  ] as const)("maps %s without leaking internal object facts", (code, status, retryClass) => {
    expect(platformPublicSafeProblem(new AssetApplicationError(code), "request-1", "correlation-1"))
      .toMatchObject({ status, body: { code, retryClass } });
  });

  it("keeps unknown Asset internals generic", () => {
    expect(platformPublicSafeProblem(new Error("ASSET_QUARANTINE_OBJECT_MISSING:secret-key"),
      "request-1", "correlation-1"))
      .toMatchObject({ status: 503, body: { code: "INTERNAL_UNAVAILABLE" } });
  });

  it("does not trust an untyped error merely because its text resembles a public code", () => {
    expect(platformPublicSafeProblem(new Error("ASSET_NOT_ACCEPTED"), "request-1", "correlation-1"))
      .toMatchObject({ status: 503, body: { code: "INTERNAL_UNAVAILABLE" } });
  });
});
