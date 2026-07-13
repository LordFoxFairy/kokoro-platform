import type { SessionSigner } from "../../domain/session.js";
import { JoseRs256SessionSigner, JoseSessionSigner } from "./jose-session-signer.js";
import { JwksProvider, loadRsaSigningKey } from "./rsa-keys.js";

// 签发链物料化结果：signer（必有）+ jwks（仅 RS256 档，HS256 无 JWKS）。
export interface ResolvedSessionSigning {
  signer: SessionSigner;
  jwks: JwksProvider | null;
}

export interface ResolveSessionSigningInput {
  privateKeyPem?: string | undefined;
  previousPrivateKeyPem?: string | undefined;
  hs256Secret?: string | undefined;
  isProduction: boolean;
}

// 签发链档位裁决（启动期，fail-fast 语义）：
//   1. 配了 RS256 私钥 → RS256 签发 + JWKS（当前 [+上一] 公钥）。生产正解。
//   2. 生产 且 未配私钥 → 抛错拒绝启动（纲领：生产 fail-closed，绝不用 HS256 共享密钥签发）。
//   3. 非生产 且 配了 HS256 secret → 退化 HS256（无 JWKS），仅 dev/test。
//   4. 都没配（非生产）→ null，/auth/sessions fail-closed（503），绝不签发未签名 token。
export function resolveSessionSigning(input: ResolveSessionSigningInput): ResolvedSessionSigning | null {
  if (input.privateKeyPem !== undefined && input.privateKeyPem.length > 0) {
    const current = loadRsaSigningKey(input.privateKeyPem);
    const previous =
      input.previousPrivateKeyPem !== undefined && input.previousPrivateKeyPem.length > 0
        ? loadRsaSigningKey(input.previousPrivateKeyPem)
        : null;
    return { signer: new JoseRs256SessionSigner(current), jwks: new JwksProvider(current, previous) };
  }

  if (input.isProduction) {
    throw new Error(
      "session signing misconfiguration: KOKORO_USER_JWT_PRIVATE_KEY (RS256) is required in production. " +
        "HS256 shared-secret signing is not allowed in production (fail-closed).",
    );
  }

  if (input.hs256Secret !== undefined && input.hs256Secret.length > 0) {
    return { signer: new JoseSessionSigner(input.hs256Secret), jwks: null };
  }

  return null;
}
