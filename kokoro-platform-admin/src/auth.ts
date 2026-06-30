import type { FastifyRequest } from "fastify";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { z } from "zod";

export type AuthMode = "oidc" | "dev";

export interface AuthConfig {
  mode: AuthMode;
  jwksUrl: string | undefined;
  issuer: string | undefined;
  audience: string | undefined;
  emailClaim: string;
  devOperator: string;
}

export class AuthError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = "AuthError";
  }
}

// 认证 = 确认「你是谁」(归 IdP/JWT)。授权(角色/租户作用域)仍归 RBAC，职责分离。
export type Authenticator = (request: FastifyRequest) => Promise<string>;

function headerValue(request: FastifyRequest, key: string): string | undefined {
  const raw = request.headers[key];
  return Array.isArray(raw) ? raw[0] : raw;
}

function bearerToken(request: FastifyRequest): string | null {
  const value = headerValue(request, "authorization");
  if (value === undefined || !value.startsWith("Bearer ")) {
    return null;
  }
  return value.slice("Bearer ".length).trim();
}

export function createAuthenticator(config: AuthConfig): Authenticator {
  if (config.mode === "dev") {
    // 仅本地：无 IdP 时沿用 x-kokoro-operator 头，默认回退到固定账号。
    return async (request) => headerValue(request, "x-kokoro-operator") ?? config.devOperator;
  }

  if (config.jwksUrl === undefined || config.jwksUrl.length === 0) {
    throw new Error("oidc auth mode requires KOKORO_ADMIN_OIDC_JWKS_URL");
  }
  const jwks = createRemoteJWKSet(new URL(config.jwksUrl));
  const verifyOptions = {
    ...(config.issuer === undefined ? {} : { issuer: config.issuer }),
    ...(config.audience === undefined ? {} : { audience: config.audience }),
  };
  const emailSchema = z.string().email();

  return async (request) => {
    const token = bearerToken(request);
    if (token === null) {
      throw new AuthError("missing bearer token", 401);
    }
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, jwks, verifyOptions));
    } catch (error) {
      throw new AuthError(`invalid token: ${error instanceof Error ? error.message : String(error)}`, 401);
    }
    const email = emailSchema.safeParse(payload[config.emailClaim]);
    if (!email.success) {
      throw new AuthError(`token missing valid ${config.emailClaim} claim`, 401);
    }
    return email.data;
  };
}
