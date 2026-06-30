import type { FastifyRequest } from "fastify";
import { describe, expect, it } from "vitest";
import { AuthError, createAuthenticator, type AuthConfig } from "../../src/auth.js";

function req(headers: Record<string, string>): FastifyRequest {
  return { headers } as unknown as FastifyRequest;
}

const devConfig: AuthConfig = {
  mode: "dev",
  jwksUrl: undefined,
  issuer: undefined,
  audience: undefined,
  emailClaim: "email",
  devOperator: "admin@kokoro.local",
};

const oidcConfig: AuthConfig = {
  ...devConfig,
  mode: "oidc",
  jwksUrl: "https://idp.example/realms/kokoro/protocol/openid-connect/certs",
};

describe("createAuthenticator dev mode", () => {
  it("returns the x-kokoro-operator header when present", async () => {
    const auth = createAuthenticator(devConfig);
    expect(await auth(req({ "x-kokoro-operator": "ops@kokoro.local" }))).toBe("ops@kokoro.local");
  });

  it("falls back to the configured dev operator when the header is absent", async () => {
    const auth = createAuthenticator(devConfig);
    expect(await auth(req({}))).toBe("admin@kokoro.local");
  });
});

describe("createAuthenticator oidc mode", () => {
  it("refuses to build without a JWKS url", () => {
    expect(() => createAuthenticator({ ...oidcConfig, jwksUrl: undefined })).toThrow();
  });

  it("rejects a request without a bearer token (401) before any network call", async () => {
    const auth = createAuthenticator(oidcConfig);
    await expect(auth(req({}))).rejects.toBeInstanceOf(AuthError);
    await expect(auth(req({ authorization: "Basic abc" }))).rejects.toMatchObject({ statusCode: 401 });
  });
});
