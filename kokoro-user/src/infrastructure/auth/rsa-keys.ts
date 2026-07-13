import { createHash, createPrivateKey, createPublicKey, type KeyObject } from "node:crypto";

// RS256 签发密钥物料：私钥对象（签发用）+ kid（公钥 SPKI 指纹前 16hex）+ 公钥 JWK（进 JWKS）。
// 私钥永不落日志/序列化/JWKS——只有公钥 JWK 对外暴露。
export interface RsaSigningKey {
  privateKey: KeyObject;
  kid: string;
  publicJwk: PublicJwk;
}

// JWKS 单条公钥（RSA）：kty/n/e 来自 node 导出，附 kid/use/alg 供验签方按 kid 选键。
export interface PublicJwk {
  kty: string;
  n: string;
  e: string;
  kid: string;
  use: "sig";
  alg: "RS256";
}

// kid = 公钥 SPKI(DER) 的 sha256 前 16 hex：确定性、随密钥轮换而变，验签方按 header.kid 选键。
export function deriveKid(publicKey: KeyObject): string {
  const spkiDer = publicKey.export({ type: "spki", format: "der" });
  return createHash("sha256").update(spkiDer).digest("hex").slice(0, 16);
}

// 从 PEM/PKCS8 私钥物料化 RS256 签发键。非 RSA 或畸形 PEM 即 fail-loud（启动期暴露配置错误）。
export function loadRsaSigningKey(pem: string): RsaSigningKey {
  const privateKey = createPrivateKey(pem);
  if (privateKey.asymmetricKeyType !== "rsa") {
    throw new Error(`KOKORO_USER_JWT_PRIVATE_KEY must be an RSA key, got ${privateKey.asymmetricKeyType ?? "unknown"}`);
  }
  const publicKey = createPublicKey(privateKey);
  const kid = deriveKid(publicKey);
  const exported = publicKey.export({ format: "jwk" }) as { kty?: string; n?: string; e?: string };
  if (exported.kty !== "RSA" || exported.n === undefined || exported.e === undefined) {
    throw new Error("failed to export RSA public JWK for JWKS");
  }
  return {
    privateKey,
    kid,
    publicJwk: { kty: "RSA", n: exported.n, e: exported.e, kid, use: "sig", alg: "RS256" },
  };
}

// JWKS 公钥集：当前键 + 可选上一把键（轮换双读）。按 kid 去重，稳定顺序（当前在前）。
export class JwksProvider {
  private readonly keys: PublicJwk[];

  constructor(current: RsaSigningKey, previous?: RsaSigningKey | null) {
    const keys = [current.publicJwk];
    if (previous && previous.kid !== current.kid) {
      keys.push(previous.publicJwk);
    }
    this.keys = keys;
  }

  jwks(): { keys: PublicJwk[] } {
    return { keys: this.keys };
  }
}
