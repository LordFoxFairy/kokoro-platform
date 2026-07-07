import { timingSafeEqual } from "node:crypto";
import type { FastifyRequest } from "fastify";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { z } from "zod";

export type AuthMode = "oidc" | "dev" | "proxy";

export interface AuthConfig {
  mode: AuthMode;
  jwksUrl: string | undefined;
  issuer: string | undefined;
  audience: string | undefined;
  emailClaim: string;
  devOperator: string;
  // BFF 注入的内部代理密钥（多值便于轮换）；proxy 模式校验。
  proxySecrets: string[];
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

// 多值并存便于轮换；timingSafeEqual 防时序，先比长度（密钥长度非敏感）。
function verifyProxySecret(provided: string, secrets: string[]): boolean {
  const providedBuf = Buffer.from(provided);
  return secrets.some((secret) => {
    const secretBuf = Buffer.from(secret);
    return secretBuf.length === providedBuf.length && timingSafeEqual(secretBuf, providedBuf);
  });
}

export function createAuthenticator(config: AuthConfig): Authenticator {
  if (config.mode === "dev") {
    // 仅本地：无 IdP 时沿用 x-kokoro-operator 头，默认回退到固定账号。
    return async (request) => headerValue(request, "x-kokoro-operator") ?? config.devOperator;
  }

  if (config.mode === "proxy") {
    // BFF 守门：校验内部代理密钥(多值轮换) + 读 operator；缺/错均 401，不 fallback。
    return async (request) => {
      const secret = headerValue(request, "x-kokoro-proxy-secret");
      if (secret === undefined || !verifyProxySecret(secret, config.proxySecrets)) {
        throw new AuthError("invalid proxy secret", 401);
      }
      const operator = headerValue(request, "x-kokoro-operator");
      if (operator === undefined || operator.length === 0) {
        throw new AuthError("missing operator header", 401);
      }
      return operator;
    };
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
