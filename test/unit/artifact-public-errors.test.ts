import { describe, expect, it } from "vitest";
import { platformPublicSafeProblem } from "../../src/interfaces/http/platform-public.js";

describe("Artifact public safe errors", () => {
  it.each([
    ["INVALID_REQUEST", 400, "INVALID_REQUEST", "never"],
    ["PAGE_CURSOR_INVALID", 400, "PAGE_CURSOR_INVALID", "never"],
    ["ARTIFACT_NOT_AVAILABLE", 404, "ARTIFACT_NOT_AVAILABLE", "never"],
    ["ARTIFACT_DELIVERY_NOT_ALLOWED", 404, "ARTIFACT_DELIVERY_NOT_ALLOWED", "never"],
    ["ARTIFACT_VERSION_NOT_READY", 422, "ARTIFACT_DELIVERY_AUTHORIZATION_REJECTED", "after_user_action"],
    ["ARTIFACT_QUERY_AMBIGUOUS", 503, "ARTIFACT_TEMPORARILY_UNAVAILABLE", "after_delay"],
  ] as const)("maps %s without exposing internal details", (message, status, code, retryClass) => {
    expect(platformPublicSafeProblem(new Error(message), "request_01", "correlation_01"))
      .toMatchObject({ status, body: { code, retryClass,
        requestId: "request_01", correlationId: "correlation_01" } });
  });
});
