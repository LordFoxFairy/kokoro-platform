import type { FastifyInstance, FastifyRequest } from "fastify";
import { sendError } from "./responses.js";

// 服务间信任头：网关/服务间调用在此比对共享密钥。
export const INTERNAL_SECRET_HEADER = "x-kokoro-internal-secret";

export interface InternalSecretGuardOptions {
  // 期望的共享密钥；空串=未配置：受保护端点直通并告警一次（本地/过渡期）。配置后不符即 401 fail-closed。
  secret: string;
  // 受保护路径前缀；缺省仅 /admin。匹配 path===prefix 或 path 以 `${prefix}/` 开头，避免 /administrators 误伤。
  protectedPrefixes?: string[];
  // 可注入便于测试；缺省 console.warn。未配置时只告警一次，不刷屏。
  warn?: (message: string) => void;
}

function headerValue(request: FastifyRequest, key: string): string | undefined {
  const raw = request.headers[key];
  return Array.isArray(raw) ? raw[0] : raw;
}

function isProtectedPath(path: string, prefixes: string[]): boolean {
  return prefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

// 入站守门：受保护端点校验 x-kokoro-internal-secret。未配置=直通并告警一次（纵深防御的过渡态）；
// 配置后缺失/不符=401 fail-closed（否则触达端口即可绕 RBAC 直打 /admin）。密钥不落日志。
export function registerInternalSecretGuard(app: FastifyInstance, options: InternalSecretGuardOptions): void {
  const prefixes = options.protectedPrefixes ?? ["/admin"];
  const warn = options.warn ?? ((message: string) => console.warn(message));
  const configured = options.secret.length > 0;
  let warned = false;

  app.addHook("onRequest", async (request, reply) => {
    const path = request.url.split("?", 1)[0] ?? request.url;
    if (!isProtectedPath(path, prefixes)) {
      return;
    }
    if (!configured) {
      if (!warned) {
        warned = true;
        warn(`[internal-secret] ${INTERNAL_SECRET_HEADER} 未配置，受保护端点直通——仅限本地/过渡期，生产须配置`);
      }
      return;
    }
    if (headerValue(request, INTERNAL_SECRET_HEADER) !== options.secret) {
      return sendError(reply, 401, "internal.unauthorized", "内部密钥缺失或不匹配");
    }
  });
}
