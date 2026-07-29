import { describe, expect, it } from "vitest";
import { createPlatformPublicOperationRegistry } from "../../src/interfaces/http/platform-public-operation-registry.js";

describe("Platform public generated operation registry", () => {
  it("uses generated method/path facts and extracts bounded path parameters", () => {
    const registry = createPlatformPublicOperationRegistry([
      { operationId: "beginRegistration", execute: async () => ({}) },
      { operationId: "completeEmailVerification", execute: async () => ({}) },
    ]);
    expect(registry.match("POST", "/v1/identity/registrations")).toMatchObject({
      descriptor: { operationId: "beginRegistration" },
      path: {},
    });
    expect(registry.match("POST", "/v1/identity/verifications/verify-1:complete")).toMatchObject({
      descriptor: { operationId: "completeEmailVerification" },
      path: { id: "verify-1" },
    });
    expect(registry.match("GET", "/v1/identity/registrations")).toBeNull();
    expect(registry.match("POST", "/v1/identity/verifications/a%2Fb:complete")).toBeNull();
  });

  it("rejects duplicate operation ownership", () => {
    expect(() => createPlatformPublicOperationRegistry([
      { operationId: "beginRegistration", execute: async () => ({}) },
      { operationId: "beginRegistration", execute: async () => ({}) },
    ])).toThrow("PLATFORM_PUBLIC_OPERATION_DUPLICATE");
  });

  it("fails composition when a required launch operation is absent", () => {
    expect(() => createPlatformPublicOperationRegistry([
      { operationId: "beginRegistration", execute: async () => ({}) },
    ], ["beginRegistration", "createIdentitySession"]))
      .toThrow("PLATFORM_PUBLIC_REQUIRED_OPERATION_MISSING");
  });
});
