import { describe, expect, it, vi } from "vitest";
import {
  createOpenIdClientAdminProvider,
  type OpenIdClientApi,
} from "../../src/modules/admin/infrastructure/oidc/openid-client-admin-provider.js";
import { OidcProviderOutcomeUnknownError } from
  "../../src/modules/admin/application/services/admin-oidc-service.js";

const registration = Object.freeze({
  issuer: "https://issuer.example.test",
  clientId: "admin-client",
  oidcAudience: "admin-audience",
  exactCallbackUri: "https://admin.example.test/auth/callback",
  returnIntentRefs: ["dashboard"],
  signingKeyRevision: "signing-1",
  deliveryKeyRevision: "delivery-1",
});

describe("openid-client Admin provider adapter", () => {
  it("uses discovery, fixed client authentication, PKCE S256, state and nonce", async () => {
    const api = fakeApi();
    const provider = await createOpenIdClientAdminProvider({
      clients: [{ registration, clientSecret: "example-client-secret" }],
      api,
    });

    expect(api.discovery).toHaveBeenCalledWith(
      new URL(registration.issuer),
      registration.clientId,
      expect.objectContaining({ id_token_signed_response_alg: "RS256" }),
      "client-secret-basic:example-client-secret",
      expect.objectContaining({ timeout: 5 }),
    );
    expect(provider.authorizationUri({
      registration,
      codeChallenge: "challenge-value",
      nonce: "nonce-value",
      state: "transaction:1",
    })).toBe("https://issuer.example.test/authorize");
    expect(api.buildAuthorizationUrl).toHaveBeenCalledWith("configuration", {
      redirect_uri: registration.exactCallbackUri,
      scope: "openid",
      audience: registration.oidcAudience,
      acr_values: "urn:kokoro:phishing-resistant",
      max_age: "300",
      code_challenge: "challenge-value",
      code_challenge_method: "S256",
      nonce: "nonce-value",
      state: "transaction:1",
    });
  });

  it("redeems only through the frozen callback, state, nonce and verifier", async () => {
    const api = fakeApi();
    const provider = await createOpenIdClientAdminProvider({
      clients: [{ registration, clientSecret: "example-client-secret" }],
      api,
    });
    const claims = await provider.redeem({
      registration,
      authorizationCode: "authorization-code",
      pkceVerifier: "pkce-verifier",
      expectedNonce: "nonce-value",
      expectedState: "transaction:1",
    });

    expect(api.authorizationCodeGrant).toHaveBeenCalledWith(
      "configuration",
      new URL(`${registration.exactCallbackUri}?code=authorization-code&state=transaction%3A1`),
      {
        expectedNonce: "nonce-value",
        expectedState: "transaction:1",
        pkceCodeVerifier: "pkce-verifier",
        idTokenExpected: true,
      },
    );
    expect(claims).toEqual({
      issuer: registration.issuer,
      subject: "oidc-subject:1",
      audience: registration.oidcAudience,
      nonce: "nonce-value",
      authenticationTime: "2026-07-29T14:59:00.000Z",
      assuranceLevel: "phishing_resistant",
      factorClasses: ["oidc", "webauthn"],
      managedDeviceRef: "device:managed:1",
    });
  });

  it("classifies network ambiguity as provider outcome unknown but preserves protocol rejection", async () => {
    const unknownApi = fakeApi({ grantError: new TypeError("fetch failed") });
    const unknownProvider = await createOpenIdClientAdminProvider({
      clients: [{ registration, clientSecret: "example-client-secret" }],
      api: unknownApi,
    });
    await expect(unknownProvider.redeem({
      registration,
      authorizationCode: "authorization-code",
      pkceVerifier: "pkce-verifier",
      expectedNonce: "nonce-value",
      expectedState: "transaction:1",
    })).rejects.toBeInstanceOf(OidcProviderOutcomeUnknownError);

    const protocol = Object.assign(new Error("invalid_grant"), { name: "AuthorizationResponseError" });
    const rejectedProvider = await createOpenIdClientAdminProvider({
      clients: [{ registration, clientSecret: "example-client-secret" }],
      api: fakeApi({ grantError: protocol }),
    });
    await expect(rejectedProvider.redeem({
      registration,
      authorizationCode: "authorization-code",
      pkceVerifier: "pkce-verifier",
      expectedNonce: "nonce-value",
      expectedState: "transaction:1",
    })).rejects.toThrow("ADMIN_OIDC_PROVIDER_REJECTED");
  });
});

function fakeApi(input: Readonly<{ grantError?: Error }> = {}): OpenIdClientApi & {
  discovery: ReturnType<typeof vi.fn>;
  buildAuthorizationUrl: ReturnType<typeof vi.fn>;
  authorizationCodeGrant: ReturnType<typeof vi.fn>;
} {
  return {
    ClientSecretBasic: (secret) => `client-secret-basic:${secret}`,
    discovery: vi.fn(async () => "configuration"),
    buildAuthorizationUrl: vi.fn(() => new URL("https://issuer.example.test/authorize")),
    authorizationCodeGrant: vi.fn(async () => {
      if (input.grantError) throw input.grantError;
      return {
        claims: () => ({
          iss: registration.issuer,
          sub: "oidc-subject:1",
          aud: registration.oidcAudience,
          nonce: "nonce-value",
          auth_time: Math.floor(Date.parse("2026-07-29T14:59:00.000Z") / 1000),
          acr: "urn:kokoro:phishing-resistant",
          amr: ["oidc", "webauthn"],
          managed_device_ref: "device:managed:1",
        }),
      };
    }),
  };
}
