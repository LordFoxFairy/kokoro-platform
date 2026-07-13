import { SignJWT } from "jose";
import type { SessionSigner, SessionTokenClaims } from "../../domain/session.js";
import type { RsaSigningKey } from "./rsa-keys.js";

// HS256 共享密钥签发，与 kokoro-session src/http/auth.ts 验签同算法同 secret。
// secret 仅作为 HMAC key 使用，永不落日志/错误/序列化。仅 dev/test 档；生产走 RS256。
export class JoseSessionSigner implements SessionSigner {
  private readonly key: Uint8Array;

  constructor(secret: string) {
    this.key = new TextEncoder().encode(secret);
  }

  async sign(claims: SessionTokenClaims): Promise<string> {
    // site_id 用 snake_case 落入 JWT payload（外部契约）；session 对其 passthrough 不校验。
    return new SignJWT({ site_id: claims.siteId })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setSubject(claims.sub)
      .setIssuer(claims.iss)
      .setIssuedAt(claims.issuedAtSeconds)
      .setExpirationTime(claims.expiresAtSeconds)
      .sign(this.key);
  }
}

// RS256 私钥签发（生产正解）：header 带 kid，验签方按 kid 从 JWKS 取公钥。私钥永不落日志/序列化。
export class JoseRs256SessionSigner implements SessionSigner {
  constructor(private readonly key: RsaSigningKey) {}

  async sign(claims: SessionTokenClaims): Promise<string> {
    return new SignJWT({ site_id: claims.siteId })
      .setProtectedHeader({ alg: "RS256", typ: "JWT", kid: this.key.kid })
      .setSubject(claims.sub)
      .setIssuer(claims.iss)
      .setIssuedAt(claims.issuedAtSeconds)
      .setExpirationTime(claims.expiresAtSeconds)
      .sign(this.key.privateKey);
  }
}
