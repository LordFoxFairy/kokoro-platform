import { describe, expect, it } from "vitest";
import { PLATFORM_API_RUNTIME_CONTRACT } from "../../src/process/platform-api-runtime-contract.js";

const EXPECTED_FILE_ENVIRONMENT = Object.freeze([
  "PLATFORM_PRODUCT_WORKLOAD_REGISTRY_FILE",
  "PLATFORM_SESSION_ACCESS_KEY_RING_FILE",
  "PLATFORM_AUTHORIZATION_EVENT_KEY_RING_FILE",
  "PLATFORM_PUBLIC_TLS_KEY_FILE",
  "PLATFORM_PUBLIC_TLS_CERT_FILE",
  "PLATFORM_PUBLIC_TLS_CLIENT_CA_FILE",
  "PLATFORM_COMMERCE_REDEMPTION_KEY_RING_FILE",
  "PLATFORM_ASSET_UPLOAD_POLICY_REGISTRY_FILE",
  "PLATFORM_ASSET_UPLOAD_CAPABILITY_KEY_RING_FILE",
  "PLATFORM_IDENTITY_PASSWORD_PEPPER_RING_FILE",
  "PLATFORM_IDENTITY_VERIFICATION_DIGEST_KEY_FILE",
  "PLATFORM_IDENTITY_SESSION_DIGEST_KEY_FILE",
  "PLATFORM_IDENTITY_REFRESH_DIGEST_KEY_FILE",
  "PLATFORM_IDENTITY_REAUTH_DIGEST_KEY_FILE",
  "PLATFORM_IDENTITY_AUDIT_DIGEST_KEY_FILE",
  "PLATFORM_IDENTITY_DELIVERY_KEY_FILE",
  "PLATFORM_IDENTITY_TOTP_KEY_RING_FILE",
]);

describe("Platform API runtime contract", () => {
  it("enumerates every production composition file exactly once", () => {
    expect(PLATFORM_API_RUNTIME_CONTRACT.trustRootEnvironment).toBe(
      "PLATFORM_API_FILE_TRUST_ROOT",
    );
    expect(PLATFORM_API_RUNTIME_CONTRACT.ports).toEqual({
      public: { environment: "PLATFORM_API_PORT", default: 4100 },
      health: { environment: "PLATFORM_API_HEALTH_PORT", default: 4101 },
    });
    expect(PLATFORM_API_RUNTIME_CONTRACT.files.map(({ environment }) => environment))
      .toEqual(EXPECTED_FILE_ENVIRONMENT);
    expect(new Set(PLATFORM_API_RUNTIME_CONTRACT.files.map(({ filename }) => filename)).size)
      .toBe(EXPECTED_FILE_ENVIRONMENT.length);
    expect(PLATFORM_API_RUNTIME_CONTRACT.files.filter(({ privateMaterial }) => privateMaterial))
      .toHaveLength(13);
  });
});
