import { describe, expect, it } from "vitest";
import { CommerceApplicationError } from "../../src/modules/commerce/application/commerce-application-error.js";
import { platformPublicSafeProblem } from "../../src/interfaces/http/platform-public.js";

describe("Commerce public problem mapping", () => {
  it("maps only typed business rejections to stable public redemption errors", () => {
    expect(platformPublicSafeProblem(
      new CommerceApplicationError("REDEEM_NOT_ACCEPTED"), "request-1", "correlation-1",
    )).toEqual({
      status: 422,
      body: {
        code: "REDEEM_NOT_ACCEPTED",
        retryClass: "never",
        requestId: "request-1",
        correlationId: "correlation-1",
        safeMessage: "The redemption was not accepted.",
      },
    });
    expect(platformPublicSafeProblem(
      new CommerceApplicationError("REDEEM_TEMPORARILY_UNAVAILABLE"), "request-1", "correlation-1",
    )).toMatchObject({ status: 503, body: { code: "REDEEM_TEMPORARILY_UNAVAILABLE", retryClass: "after_delay" } });
  });

  it("does not convert an internal error merely because its message resembles a business code", () => {
    expect(platformPublicSafeProblem(
      new Error("REDEEM_NOT_ACCEPTED"), "request-1", "correlation-1",
    )).toMatchObject({ status: 503, body: { code: "INTERNAL_UNAVAILABLE" } });
  });

  it("maps the repository's canonical idempotency conflict to HTTP 409", () => {
    expect(platformPublicSafeProblem(
      new Error("IDEMPOTENCY_CONFLICT"), "request-1", "correlation-1",
    )).toMatchObject({ status: 409, body: { code: "IDEMPOTENCY_CONFLICT", retryClass: "never" } });
  });

  it("does not disclose whether another actor owns a redemption lookup", () => {
    expect(platformPublicSafeProblem(
      new CommerceApplicationError("REDEMPTION_NOT_FOUND"), "request-1", "correlation-1",
    )).toMatchObject({
      status: 404,
      body: { code: "NOT_FOUND", retryClass: "never", safeMessage: "The requested resource was not found." },
    });
  });
});
