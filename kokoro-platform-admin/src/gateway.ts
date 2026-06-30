import { adminModuleManifestSchema, type AdminModuleManifest } from "@kokoro/platform-kit";
import { z } from "zod";
import type { ModuleConfig } from "./config.js";
import { permits, type Operator } from "./rbac.js";

// sendData 包装：所有模块端点响应都是 { data: <payload> }
const manifestEnvelopeSchema = z.object({ data: adminModuleManifestSchema });
const resourceEnvelopeSchema = z.object({ data: z.array(z.record(z.unknown())) });

export interface ModuleOnline {
  id: string;
  label: string;
  baseUrl: string;
  online: true;
  manifest: AdminModuleManifest;
}

export interface ModuleOffline {
  id: string;
  label: string;
  baseUrl: string;
  online: false;
  error: string;
}

export type ModuleStatus = ModuleOnline | ModuleOffline;

function joinUrl(baseUrl: string, path: string): string {
  return new URL(path, baseUrl).toString();
}

async function fetchManifest(module: ModuleConfig): Promise<ModuleStatus> {
  try {
    const response = await fetch(joinUrl(module.baseUrl, module.manifestPath));
    if (!response.ok) {
      return { id: module.id, label: module.label, baseUrl: module.baseUrl, online: false, error: `HTTP ${response.status}` };
    }
    const body: unknown = await response.json();
    const manifest = manifestEnvelopeSchema.parse(body).data;
    return { id: module.id, label: module.label, baseUrl: module.baseUrl, online: true, manifest };
  } catch (error) {
    return {
      id: module.id,
      label: module.label,
      baseUrl: module.baseUrl,
      online: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function getManifests(modules: ModuleConfig[]): Promise<ModuleStatus[]> {
  return Promise.all(modules.map(fetchManifest));
}

export class GatewayError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = "GatewayError";
  }
}

export type ResourceRow = Record<string, unknown>;

// 校验 moduleId 已知 + route ∈ manifest.resources[].route，防开放代理/SSRF
export async function proxyResource(
  modules: ModuleConfig[],
  moduleId: string,
  route: string,
): Promise<ResourceRow[]> {
  const module = modules.find((candidate) => candidate.id === moduleId);
  if (!module) {
    throw new GatewayError(`unknown module: ${moduleId}`, 400);
  }

  const status = await fetchManifest(module);
  if (!status.online) {
    throw new GatewayError(`module offline: ${status.error}`, 502);
  }

  const allowed = status.manifest.resources.some((resource) => resource.route === route);
  if (!allowed) {
    throw new GatewayError(`route not allowed for module ${moduleId}: ${route}`, 403);
  }

  const response = await fetch(joinUrl(module.baseUrl, route));
  if (!response.ok) {
    throw new GatewayError(`upstream returned HTTP ${response.status}`, 502);
  }

  const body: unknown = await response.json();
  return resourceEnvelopeSchema.parse(body).data;
}

export interface ActionRequest {
  moduleId: string;
  resourceId: string;
  actionId: string;
  params?: Record<string, string>;
  body?: unknown;
  siteId?: string;
  reason?: string;
}

export interface AuditEntry {
  actorOperatorId?: string;
  actorEmail?: string;
  moduleId: string;
  resourceId: string;
  actionId: string;
  targetRoute: string;
  siteId?: string;
  reason?: string;
  result: "ok" | "error";
  statusCode: number;
  requestId: string;
}

export interface AuditSink {
  record(entry: AuditEntry): Promise<void>;
}

const actionResultSchema = z.object({ data: z.unknown() });

// 安全：route 来自 manifest（受信合约），仅 :param 由客户端填且 encodeURIComponent，杜绝路径穿越/越权代理。
function resolveRoute(template: string, params: Record<string, string>): string {
  return template.replace(/:([A-Za-z0-9_]+)/g, (_match, key: string) => {
    const value = params[key];
    if (value === undefined) {
      throw new GatewayError(`missing path param: ${key}`, 400);
    }
    return encodeURIComponent(value);
  });
}

// 写操作代理（守门人）：校验 action ∈ manifest、RBAC 鉴权、dangerMutation 强制 reason、带 siteId 转发、无论成败/拒绝都落一条审计。
export async function proxyAction(
  modules: ModuleConfig[],
  audit: AuditSink,
  request: ActionRequest,
  requestId: string,
  operator: Operator,
): Promise<unknown> {
  const module = modules.find((candidate) => candidate.id === request.moduleId);
  if (!module) {
    throw new GatewayError(`unknown module: ${request.moduleId}`, 400);
  }

  const status = await fetchManifest(module);
  if (!status.online) {
    throw new GatewayError(`module offline: ${status.error}`, 502);
  }

  const resource = status.manifest.resources.find((candidate) => candidate.id === request.resourceId);
  const action = resource?.actions.find((candidate) => candidate.id === request.actionId);
  if (!action) {
    throw new GatewayError(`unknown action: ${request.resourceId}/${request.actionId}`, 403);
  }
  if (action.route === undefined) {
    throw new GatewayError(`action not proxyable (no route declared): ${request.actionId}`, 400);
  }

  const route = resolveRoute(action.route, request.params ?? {});
  const auditBase = {
    actorOperatorId: operator.id,
    actorEmail: operator.email,
    moduleId: request.moduleId,
    resourceId: request.resourceId,
    actionId: request.actionId,
    targetRoute: route,
    ...(request.siteId === undefined ? {} : { siteId: request.siteId }),
    ...(request.reason === undefined ? {} : { reason: request.reason }),
  };

  if (!permits(operator.permissions, action.requiredPermission)) {
    await audit.record({ ...auditBase, result: "error", statusCode: 403, requestId });
    throw new GatewayError(`permission denied: ${action.requiredPermission}`, 403);
  }
  if (action.kind === "dangerMutation" && (request.reason === undefined || request.reason.trim() === "")) {
    throw new GatewayError(`reason required for dangerous action: ${request.actionId}`, 400);
  }

  const headers: Record<string, string> = { "content-type": "application/json", "x-kokoro-request-id": requestId };
  if (request.siteId !== undefined) {
    headers["x-kokoro-site-id"] = request.siteId;
  }

  let response: Response;
  try {
    response = await fetch(joinUrl(module.baseUrl, route), {
      method: action.method,
      headers,
      body: JSON.stringify(request.body ?? {}),
    });
  } catch (error) {
    await audit.record({ ...auditBase, result: "error", statusCode: 0, requestId });
    throw new GatewayError(error instanceof Error ? error.message : String(error), 502);
  }

  const body: unknown = await response.json().catch(() => null);
  await audit.record({ ...auditBase, result: response.ok ? "ok" : "error", statusCode: response.status, requestId });
  if (!response.ok) {
    throw new GatewayError(`upstream returned HTTP ${response.status}`, 502);
  }

  const unwrapped = actionResultSchema.safeParse(body);
  return unwrapped.success ? unwrapped.data.data : body;
}

// 站点选择器数据源。
export async function getSites(modules: ModuleConfig[]): Promise<ResourceRow[]> {
  return proxyResource(modules, "site", "/admin/sites");
}

export interface User360Query {
  siteId: string;
  ownerKind: "user" | "team";
  ownerId: string;
}

export interface User360 {
  creditAccount: ResourceRow | null;
  orders: ResourceRow[];
  identity: ResourceRow | null;
}

// 用户360：按 (siteId, owner) 聚合身份 + 积分账户 + 订单。复用各模块 list 端点 + 站内过滤；
// 某模块离线则该段降级为空，不拖垮整体。
export async function getUser360(modules: ModuleConfig[], query: User360Query): Promise<User360> {
  const [accounts, orders, users] = await Promise.all([
    proxyResource(modules, "credit", "/admin/credits/accounts").catch(() => [] as ResourceRow[]),
    proxyResource(modules, "payment", "/admin/payments/orders").catch(() => [] as ResourceRow[]),
    proxyResource(modules, "user", "/admin/users").catch(() => [] as ResourceRow[]),
  ]);

  const creditAccount =
    accounts.find(
      (row) => row.siteId === query.siteId && row.ownerKind === query.ownerKind && row.ownerId === query.ownerId,
    ) ?? null;

  const teamId = query.ownerKind === "team" ? query.ownerId : null;
  const filteredOrders = orders.filter((row) => row.siteId === query.siteId && (teamId === null || row.teamId === teamId));

  const identity =
    query.ownerKind === "user"
      ? (users.find((row) => row.siteId === query.siteId && row.id === query.ownerId) ?? null)
      : null;

  return { creditAccount, orders: filteredOrders, identity };
}
