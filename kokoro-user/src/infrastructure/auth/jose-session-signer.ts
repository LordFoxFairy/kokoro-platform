import { SignJWT } from "jose";
import type { SessionSigner, SessionTokenClaims } from "../../domain/session.js";

// HS256 共享密钥签发，与 kokoro-session src/http/auth.ts 验签同算法同 secret。
// secret 仅作为 HMAC key 使用，永不落日志/错误/序列化。
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
