import { z } from "zod";

// 网关统一信封：成功 {data}，失败 {error:{code,message}}。
const errorEnvelope = z.object({ error: z.object({ message: z.string() }).partial().passthrough() }).passthrough();

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

// 同源调网关；非 2xx 抛错。data 由调用方用 schema 洗净，绝不裸传。
async function request(path: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(path, { ...init, headers: { ...(init?.headers ?? {}) } });
  const raw: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const parsed = errorEnvelope.safeParse(raw);
    const message = parsed.success ? (parsed.data.error.message ?? `HTTP ${res.status}`) : `HTTP ${res.status}`;
    throw new ApiError(res.status, message);
  }
  const envelope = z.object({ data: z.unknown() }).safeParse(raw);
  return envelope.success ? envelope.data.data : undefined;
}

export async function apiGet<T>(path: string, schema: z.ZodType<T>): Promise<T> {
  return schema.parse(await request(path));
}

export async function apiPost<T>(path: string, body: unknown, schema: z.ZodType<T>): Promise<T> {
  const data = await request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return schema.parse(data);
}

export function queryString(params: Record<string, string>): string {
  return new URLSearchParams(params).toString();
}
