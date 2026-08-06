import { describe, expect, it } from "vitest";
import {
  zRedeemArtifactDeliveryAuthorizationHeaders,
  zSubmitMediaOperationHeaders,
} from "../../src/generated/contracts/openapi/platform-public/zod.gen.js";
import { platformPublicRequestHeaders } from "../../src/interfaces/http/platform-public.js";

describe("Platform Public generated header extraction", () => {
  it("accepts every generated Media command header without a handwritten allowlist", () => {
    const fingerprint = "a".repeat(64);
    const extracted = platformPublicRequestHeaders(zSubmitMediaOperationHeaders, {
      "kokoro-contract-version": "1",
      "x-kokoro-command-id": "0198f758-2534-7bbb-8bbb-0123456789ab",
      "idempotency-key": "idempotency-key-0001",
      "x-csrf-token": "c".repeat(32),
      "x-kokoro-caller-request-fingerprint": fingerprint,
      "x-untrusted-extra": "must-not-cross-the-contract-boundary",
    });

    expect(zSubmitMediaOperationHeaders.parse(extracted)).toMatchObject({
      "X-Kokoro-Caller-Request-Fingerprint": fingerprint,
    });
    expect(extracted).not.toHaveProperty("x-untrusted-extra");
  });

  it("coerces only canonical generated integer headers and retains Range", () => {
    const extracted = platformPublicRequestHeaders(zRedeemArtifactDeliveryAuthorizationHeaders, {
      "kokoro-contract-version": "1",
      range: "bytes=2-5",
      "x-kokoro-request-deadline-ms": "30000",
    });

    expect(zRedeemArtifactDeliveryAuthorizationHeaders.parse(extracted)).toEqual({
      "Kokoro-Contract-Version": "1",
      Range: "bytes=2-5",
      "X-Kokoro-Request-Deadline-Ms": 30000,
    });
  });
});
