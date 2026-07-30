import * as openid from "openid-client";
import {
  OidcProviderOutcomeUnknownError,
  type AdminOidcProviderClaims,
  type AdminOidcRegistration,
} from "../../application/services/admin-oidc-service.js";

type OpenIdConfiguration = unknown;
type OpenIdClientAuthentication = unknown;

interface OpenIdTokenResponse {
  claims(): Readonly<Record<string, unknown>> | undefined;
}

export interface OpenIdClientApi {
  ClientSecretBasic(secret: string): OpenIdClientAuthentication;
  discovery(
    issuer: URL,
    clientId: string,
    metadata: Readonly<Record<string, unknown>>,
    clientAuthentication: OpenIdClientAuthentication,
    options: Readonly<{ timeout: number }>,
  ): Promise<OpenIdConfiguration>;
  buildAuthorizationUrl(
    configuration: OpenIdConfiguration,
    parameters: Readonly<Record<string, string>>,
  ): URL;
  authorizationCodeGrant(
    configuration: OpenIdConfiguration,
    currentUrl: URL,
    checks: Readonly<{
      expectedNonce: string;
      expectedState: string;
      pkceCodeVerifier: string;
      idTokenExpected: true;
    }>,
  ): Promise<OpenIdTokenResponse>;
}

const DEFAULT_OPENID_CLIENT: OpenIdClientApi = Object.freeze({
  ClientSecretBasic: (secret: string) => openid.ClientSecretBasic(secret),
  discovery: (
    issuer: URL,
    clientId: string,
    metadata: Readonly<Record<string, unknown>>,
    clientAuthentication: OpenIdClientAuthentication,
    options: Readonly<{ timeout: number }>,
  ) => openid.discovery(
    issuer,
    clientId,
    metadata as Partial<openid.ClientMetadata>,
    clientAuthentication as openid.ClientAuth,
    options,
  ),
  buildAuthorizationUrl: (
    configuration: OpenIdConfiguration,
    parameters: Readonly<Record<string, string>>,
  ) => openid.buildAuthorizationUrl(configuration as openid.Configuration, parameters),
  authorizationCodeGrant: async (
    configuration: OpenIdConfiguration,
    currentUrl: URL,
    checks: Readonly<{
      expectedNonce: string;
      expectedState: string;
      pkceCodeVerifier: string;
      idTokenExpected: true;
    }>,
  ) => openid.authorizationCodeGrant(configuration as openid.Configuration, currentUrl, checks),
});

export interface OpenIdClientAdminProvider {
  authorizationUri(input: Readonly<{
    registration: AdminOidcRegistration;
    codeChallenge: string;
    nonce: string;
    state: string;
  }>): string;
  redeem(input: Readonly<{
    registration: AdminOidcRegistration;
    authorizationCode: string;
    pkceVerifier: string;
    expectedNonce: string;
    expectedState: string;
  }>): Promise<AdminOidcProviderClaims>;
}

export async function createOpenIdClientAdminProvider(input: Readonly<{
  clients: readonly Readonly<{
    registration: AdminOidcRegistration;
    clientSecret: string;
  }>[];
  api?: OpenIdClientApi;
}>): Promise<OpenIdClientAdminProvider> {
  if (input.clients.length < 1 || input.clients.length > 32) {
    throw new Error("ADMIN_OIDC_CLIENT_REGISTRY_INVALID");
  }
  const api = input.api ?? DEFAULT_OPENID_CLIENT;
  const configurations = new Map<string, OpenIdConfiguration>();
  for (const client of input.clients) {
    validateClient(client.registration, client.clientSecret);
    const key = registrationKey(client.registration);
    if (configurations.has(key)) throw new Error("ADMIN_OIDC_CLIENT_DUPLICATE");
    const configuration = await api.discovery(
      new URL(client.registration.issuer),
      client.registration.clientId,
      {
        client_id: client.registration.clientId,
        redirect_uris: [client.registration.exactCallbackUri],
        response_types: ["code"],
        grant_types: ["authorization_code"],
        token_endpoint_auth_method: "client_secret_basic",
        id_token_signed_response_alg: "RS256",
      },
      api.ClientSecretBasic(client.clientSecret),
      { timeout: 5 },
    );
    configurations.set(key, configuration);
  }

  const requireConfiguration = (registration: AdminOidcRegistration): OpenIdConfiguration => {
    const value = configurations.get(registrationKey(registration));
    if (value === undefined) throw new Error("ADMIN_OIDC_CLIENT_NOT_REGISTERED");
    return value;
  };

  const provider: OpenIdClientAdminProvider = {
    authorizationUri(request: Parameters<OpenIdClientAdminProvider["authorizationUri"]>[0]) {
      const url = api.buildAuthorizationUrl(requireConfiguration(request.registration), {
        redirect_uri: request.registration.exactCallbackUri,
        scope: "openid",
        audience: request.registration.oidcAudience,
        acr_values: "urn:kokoro:phishing-resistant",
        max_age: "300",
        code_challenge: request.codeChallenge,
        code_challenge_method: "S256",
        nonce: request.nonce,
        state: request.state,
      });
      if (url.protocol !== "https:" || url.username || url.password || url.hash) {
        throw new Error("ADMIN_OIDC_AUTHORIZATION_URI_INVALID");
      }
      return url.href;
    },

    async redeem(request: Parameters<OpenIdClientAdminProvider["redeem"]>[0]) {
      const callback = new URL(request.registration.exactCallbackUri);
      callback.searchParams.set("code", request.authorizationCode);
      callback.searchParams.set("state", request.expectedState);
      let token: OpenIdTokenResponse;
      try {
        token = await api.authorizationCodeGrant(
          requireConfiguration(request.registration),
          callback,
          {
            expectedNonce: request.expectedNonce,
            expectedState: request.expectedState,
            pkceCodeVerifier: request.pkceVerifier,
            idTokenExpected: true,
          },
        );
      } catch (error) {
        if (providerOutcomeUnknown(error)) throw new OidcProviderOutcomeUnknownError();
        throw new Error("ADMIN_OIDC_PROVIDER_REJECTED");
      }
      return claims(token.claims(), request.registration, request.expectedNonce);
    },
  };
  return Object.freeze(provider);
}

function claims(
  value: Readonly<Record<string, unknown>> | undefined,
  registration: AdminOidcRegistration,
  expectedNonce: string,
): AdminOidcProviderClaims {
  if (value === undefined) throw new Error("ADMIN_OIDC_ID_TOKEN_REQUIRED");
  const issuer = string(value.iss);
  const subject = string(value.sub);
  const audience = singleAudience(value.aud);
  const nonce = string(value.nonce);
  const authTime = integer(value.auth_time);
  const acr = string(value.acr);
  const factorClasses = stringArray(value.amr);
  const managedDeviceRef = string(value.managed_device_ref);
  if (
    issuer !== registration.issuer || audience !== registration.oidcAudience ||
    nonce !== expectedNonce || acr !== "urn:kokoro:phishing-resistant" ||
    !factorClasses.includes("webauthn")
  ) throw new Error("ADMIN_OIDC_ID_TOKEN_CLAIMS_INVALID");
  return Object.freeze({
    issuer,
    subject,
    audience,
    nonce,
    authenticationTime: new Date(authTime * 1000).toISOString(),
    assuranceLevel: "phishing_resistant",
    factorClasses: Object.freeze(factorClasses),
    managedDeviceRef,
  });
}

function providerOutcomeUnknown(error: unknown): boolean {
  return error instanceof TypeError ||
    (error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name));
}

function validateClient(registration: AdminOidcRegistration, clientSecret: string): void {
  const issuer = new URL(registration.issuer);
  const callback = new URL(registration.exactCallbackUri);
  if (
    issuer.protocol !== "https:" || callback.protocol !== "https:" ||
    issuer.username || issuer.password || issuer.hash || callback.username ||
    callback.password || callback.hash || clientSecret.length < 16 || clientSecret.length > 4096
  ) throw new Error("ADMIN_OIDC_CLIENT_REGISTRY_INVALID");
}

function registrationKey(value: AdminOidcRegistration): string {
  return `${value.issuer}\0${value.clientId}\0${value.exactCallbackUri}`;
}

function string(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 1024) {
    throw new Error("ADMIN_OIDC_ID_TOKEN_CLAIMS_INVALID");
  }
  return value;
}

function integer(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new Error("ADMIN_OIDC_ID_TOKEN_CLAIMS_INVALID");
  }
  return value;
}

function singleAudience(value: unknown): string {
  if (typeof value === "string") return string(value);
  if (Array.isArray(value) && value.length === 1) return string(value[0]);
  throw new Error("ADMIN_OIDC_ID_TOKEN_CLAIMS_INVALID");
}

function stringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 16) {
    throw new Error("ADMIN_OIDC_ID_TOKEN_CLAIMS_INVALID");
  }
  const result = value.map(string);
  if (new Set(result).size !== result.length) throw new Error("ADMIN_OIDC_ID_TOKEN_CLAIMS_INVALID");
  return Object.freeze(result);
}
