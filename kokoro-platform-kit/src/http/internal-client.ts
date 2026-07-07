import { z, type ZodType } from "zod";
import { AppError } from "../domain/errors.js";
import { contextHeaders, type RequestContext } from "./request-context.js";

export interface CallServiceOptions<T> {
  baseUrl: string;
  method: "GET" | "POST";
  path: string;
  schema: ZodType<T>;
  body?: unknown;
  // 内部信任头：网关/服务间认证，proxy 模式校验。
  internalSecret?: string;
  // 可注入便于测试；默认全局 fetch。
  fetchImpl?: typeof fetch;
}

const errorEnvelope = z.object({
  error: z.object({ code: z.string(), message: z.string(), details: z.unknown().optional() }),
});
const dataEnvelope = z.object({ data: z.unknown() });

// 跨服务调用：透传上下文头（requestId/siteId/principal）+ 内部密钥；非 2xx 映射 AppError，响应经 schema 洗净。
export async function callService<T>(ctx: RequestContext, opts: CallServiceOptions<T>): Promise<T> {
  const doFetch = opts.fetchImpl ?? fetch;
  const headers: Record<string, string> = { ...contextHeaders(ctx) };
  if (opts.internalSecret !== undefined) {
    headers["x-kokoro-internal-secret"] = opts.internalSecret;
  }
  const init: { method: string; headers: Record<string, string>; body?: string } = {
    method: opts.method,
    headers,
  };
  if (opts.body !== undefined) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(opts.body);
  }

  let res: Response;
  try {
    res = await doFetch(joinUrl(opts.baseUrl, opts.path), init);
  } catch {
    throw new AppError("upstream.unreachable", 502, `无法连接下游服务 ${opts.baseUrl}`);
  }

  const raw: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const parsed = errorEnvelope.safeParse(raw);
    const code = parsed.success ? parsed.data.error.code : "upstream.error";
    const message = parsed.success ? parsed.data.error.message : `HTTP ${res.status}`;
    const details = parsed.success ? parsed.data.error.details : undefined;
    throw new AppError(code, res.status, message, details);
  }
  const envelope = dataEnvelope.safeParse(raw);
  return opts.schema.parse(envelope.success ? envelope.data.data : raw);
}

function joinUrl(baseUrl: string, path: string): string {
  const normalizedBase = baseUrl.replace(/\/+$/, "");
  const normalizedPath = path.replace(/^\/+/, "");
  if (normalizedPath.length === 0) {
    return normalizedBase;
  }
  return `${normalizedBase}/${normalizedPath}`;
}
