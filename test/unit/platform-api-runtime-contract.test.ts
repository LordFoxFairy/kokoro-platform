import { describe, expect, it } from "vitest";
import {
  PLATFORM_API_RUNTIME_CONTRACT,
  createPlatformApiRuntimeFileReader,
  loadPlatformApiRuntimePorts,
} from "../../src/process/platform-api-runtime-contract.js";

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
  "PLATFORM_ARTIFACT_DELIVERY_CAPABILITY_KEY_FILE",
  "PLATFORM_ARTIFACT_OWNER_CURSOR_KEY_FILE",
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
      .toHaveLength(15);
    expect(PLATFORM_API_RUNTIME_CONTRACT.uncomposedFiles).toEqual([{
      environment: "PLATFORM_MEMORY_CONTENT_KEY_RING_FILE",
      filename: "memory-content-keys.json",
      privateMaterial: true,
      secretClass: "memory-content-encryption-keyring",
    }]);
  });

  it("loads strict public and health ports from the runtime contract", () => {
    expect(loadPlatformApiRuntimePorts({})).toEqual({ public: 4100, health: 4101 });
    expect(loadPlatformApiRuntimePorts({
      PLATFORM_API_PORT: "5100",
      PLATFORM_API_HEALTH_PORT: "5101",
    }))
      .toEqual({ public: 5100, health: 5101 });
    for (const invalid of ["0", "01", "4100junk", " 4100", "65536"]) {
      expect(() => loadPlatformApiRuntimePorts({ PLATFORM_API_PORT: invalid }))
        .toThrowError("PLATFORM_API_PORT_INVALID");
      expect(() => loadPlatformApiRuntimePorts({ PLATFORM_API_HEALTH_PORT: invalid }))
        .toThrowError("PLATFORM_API_HEALTH_PORT_INVALID");
    }
  });

  it("uses each file contract privateMaterial classification to select the reader", async () => {
    const calls: string[] = [];
    const reader = createPlatformApiRuntimeFileReader({
      readPrivate: async (path) => { calls.push(`private:${path}`); return "private"; },
      readRegular: async (path) => { calls.push(`regular:${path}`); return "regular"; },
    });

    await expect(reader.read(
      "PLATFORM_PUBLIC_TLS_KEY_FILE", "/trust/server.key", 1024, "TLS_KEY_INVALID",
    )).resolves.toBe("private");
    await expect(reader.read(
      "PLATFORM_PUBLIC_TLS_CERT_FILE", "/trust/server.crt", 1024, "TLS_CERT_INVALID",
    )).resolves.toBe("regular");
    await expect(reader.read(
      "PLATFORM_MEMORY_CONTENT_KEY_RING_FILE", "/trust/memory.json", 1024,
      "MEMORY_KEY_RING_INVALID",
    )).resolves.toBe("private");
    expect(calls).toEqual([
      "private:/trust/server.key", "regular:/trust/server.crt", "private:/trust/memory.json",
    ]);
  });
});
