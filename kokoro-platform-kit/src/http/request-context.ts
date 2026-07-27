import { randomUUID } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import { z } from "zod";

// 四类调用主体；header 是外部边界，用 Zod 洗净。
export const principalSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("user"), userId: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("service"), serviceAccountId: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("operator"), operatorId: z.string().min(1), roleKey: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("system") }).strict(),
  z.object({ kind: z.literal("anonymous") }).strict(),
]);

export type Principal = z.infer<typeof principalSchema>;

const ANONYMOUS_PRINCIPAL: Principal = { kind: "anonymous" };

export interface RequestContext {
  requestId: string;
  siteId: string | null;
  principal: Principal;
  teamId?: string;
}

const HEADER_REQUEST_ID = "x-kokoro-request-id";
const HEADER_SITE_ID = "x-kokoro-site-id";
const HEADER_TEAM_ID = "x-kokoro-team-id";
const HEADER_PRINCIPAL = "x-kokoro-principal";

export class SiteContextRequiredError extends Error {
  constructor() {
    super("siteId is required for this operation");
    this.name = "SiteContextRequiredError";
  }
}

function headerValue(headers: IncomingHttpHeaders, key: string): string | undefined {
  const raw = headers[key];
  return Array.isArray(raw) ? raw[0] : raw;
}

// 缺失或脏 principal header 必须 fail-closed 为 anonymous；system 只能由受信内部调用方显式传入。
function parsePrincipal(raw: string | undefined): Principal {
  if (!raw) {
    return ANONYMOUS_PRINCIPAL;
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return ANONYMOUS_PRINCIPAL;
  }
  const result = principalSchema.safeParse(json);
  return result.success ? result.data : ANONYMOUS_PRINCIPAL;
}

export function readRequestContext(headers: IncomingHttpHeaders): RequestContext {
  const requestId = headerValue(headers, HEADER_REQUEST_ID) ?? randomUUID();
  const siteId = headerValue(headers, HEADER_SITE_ID) ?? null;
  const principal = parsePrincipal(headerValue(headers, HEADER_PRINCIPAL));
  const teamId = headerValue(headers, HEADER_TEAM_ID);
  return teamId === undefined
    ? { requestId, siteId, principal }
    : { requestId, siteId, principal, teamId };
}

export function requireSite(context: RequestContext): string {
  if (context.siteId === null) {
    throw new SiteContextRequiredError();
  }
  return context.siteId;
}

// 序列化为出站 header，供跨服务调用透传链路上下文。
export function contextHeaders(context: RequestContext): Record<string, string> {
  const headers: Record<string, string> = {
    [HEADER_REQUEST_ID]: context.requestId,
    [HEADER_PRINCIPAL]: JSON.stringify(context.principal),
  };
  if (context.siteId !== null) {
    headers[HEADER_SITE_ID] = context.siteId;
  }
  if (context.teamId !== undefined) {
    headers[HEADER_TEAM_ID] = context.teamId;
  }
  return headers;
}
