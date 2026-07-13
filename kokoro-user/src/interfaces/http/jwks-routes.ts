import type { FastifyInstance } from "fastify";
import type { JwksProvider } from "../../infrastructure/auth/rsa-keys.js";

// RS256 公钥暴露面（RFC 7517）：session 验签方按 token header.kid 从这里取公钥。
// 公开 GET（route-access public，见 server.ts）；返回原始 { keys: [...] } 顶层结构，不套 data 信封
// ——JWKS 消费方（jose/node 验签）按标准形状解析。私钥永不出现在此面。
export function registerJwksRoutes(app: FastifyInstance, jwks: JwksProvider): void {
  app.get(
    "/.well-known/jwks.json",
    {
      schema: {
        tags: ["auth"],
        summary: "RS256 会话签发公钥集（JWKS）",
      },
    },
    async (_request, reply) => {
      // 公钥集短缓存：验签方内存缓存自有 TTL，这里给下游代理一个温和的 5min 提示。
      return reply.header("cache-control", "public, max-age=300").code(200).send(jwks.jwks());
    },
  );
}
