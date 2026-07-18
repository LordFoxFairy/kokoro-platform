import { adminModuleManifestSchema, type AdminModuleManifest } from "@kokoro/platform-kit";
import { z } from "zod";
import type { ModuleConfig } from "./config.js";
import { permits, permitsSite, type Operator } from "./rbac.js";

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

// 网关出站身份=admin：非空 secret 时带 x-kokoro-service:admin + 内部密钥，供模块 route-access 校验 admin 等级。
function adminCallerHeaders(internalSecret: string): Record<string, string> {
  if (internalSecret.length === 0) {
    return {};
  }
  return { "x-kokoro-service": "admin", "x-kokoro-internal-secret": internalSecret };
}

async function fetchManifest(module: ModuleConfig, internalSecret = ""): Promise<ModuleStatus> {
  try {
    const response = await fetch(joinUrl(module.baseUrl, module.manifestPath), {
      headers: adminCallerHeaders(internalSecret),
    });
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

export async function getManifests(modules: ModuleConfig[], internalSecret = ""): Promise<ModuleStatus[]> {
  return Promise.all(modules.map((module) => fetchManifest(module, internalSecret)));
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

export interface ResourceScopeOptions {
  operator?: Operator;
  siteId?: string;
}

function normalizeResourceScope(scope?: Operator | ResourceScopeOptions): ResourceScopeOptions {
  if (scope === undefined) {
    return {};
  }
  if ("permissions" in scope && "scopeSites" in scope) {
    return { operator: scope };
  }
  return scope;
}

function filterResourceRows(rows: ResourceRow[], scope: ResourceScopeOptions): ResourceRow[] {
  if (scope.siteId !== undefined) {
    return rows.filter((row) => row.siteId === scope.siteId);
  }

  const operator = scope.operator;
  if (operator === undefined || operator.scopeSites.includes("*")) {
    return rows;
  }

  return rows.filter((row) => typeof row.siteId === "string" && permitsSite(operator.scopeSites, row.siteId));
}

// 校验 moduleId 已知 + route ∈ manifest.resources[].route，防开放代理/SSRF
export async function proxyResource(
  modules: ModuleConfig[],
  moduleId: string,
  route: string,
  scopeInput?: Operator | ResourceScopeOptions,
  internalSecret = "",
): Promise<ResourceRow[]> {
  const scope = normalizeResourceScope(scopeInput);
  const module = modules.find((candidate) => candidate.id === moduleId);
  if (!module) {
    throw new GatewayError(`unknown module: ${moduleId}`, 400);
  }

  const status = await fetchManifest(module, internalSecret);
  if (!status.online) {
    throw new GatewayError(`module offline: ${status.error}`, 502);
  }

  // route 必须由 manifest 声明（防开放代理/SSRF）；传入 operator 时强制其对该 resource 的 requiredPermission。
  const resource = status.manifest.resources.find((candidate) => candidate.route === route);
  if (!resource) {
    throw new GatewayError(`route not allowed for module ${moduleId}: ${route}`, 403);
  }
  if (scope.operator && !permits(scope.operator.permissions, resource.requiredPermission)) {
    throw new GatewayError(`permission denied: ${resource.requiredPermission}`, 403);
  }
  if (scope.operator && scope.siteId !== undefined && !permitsSite(scope.operator.scopeSites, scope.siteId)) {
    throw new GatewayError(`tenant out of scope: ${scope.siteId}`, 403);
  }

  const response = await fetch(joinUrl(module.baseUrl, route), {
    headers: adminCallerHeaders(internalSecret),
  });
  if (!response.ok) {
    throw new GatewayError(`upstream returned HTTP ${response.status}`, 502);
  }

  const body: unknown = await response.json();
  return filterResourceRows(resourceEnvelopeSchema.parse(body).data, scope);
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

type AuditBase = Omit<AuditEntry, "result" | "statusCode" | "requestId">;

export interface PreparedAction {
  module: ModuleConfig;
  method: "POST" | "DELETE";
  route: string;
  requiredPermission: string;
  kind: "link" | "mutation" | "dangerMutation";
  auditBase: AuditBase;
  // 转发时落 x-kokoro-operator：模块侧审计不再归 system,归真实操作者。
  operator: Operator;
}

// 守门人前置：校验 action ∈ manifest + RBAC(权限/租户作用域) + dangerMutation 强制 reason；拒绝落审计后抛错。不执行。
export async function prepareAction(
  modules: ModuleConfig[],
  audit: AuditSink,
  request: ActionRequest,
  requestId: string,
  operator: Operator,
  internalSecret = "",
): Promise<PreparedAction> {
  const module = modules.find((candidate) => candidate.id === request.moduleId);
  if (!module) {
    throw new GatewayError(`unknown module: ${request.moduleId}`, 400);
  }

  const status = await fetchManifest(module, internalSecret);
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
  const auditBase: AuditBase = {
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
  const siteAllowed =
    request.siteId === undefined ? operator.scopeSites.includes("*") : permitsSite(operator.scopeSites, request.siteId);
  if (!siteAllowed) {
    await audit.record({ ...auditBase, result: "error", statusCode: 403, requestId });
    throw new GatewayError(`tenant out of scope: ${request.siteId ?? "platform"}`, 403);
  }
  if (action.kind === "dangerMutation" && (request.reason === undefined || request.reason.trim() === "")) {
    throw new GatewayError(`reason required for dangerous action: ${request.actionId}`, 400);
  }

  return {
    module,
    method: action.method,
    route,
    requiredPermission: action.requiredPermission,
    kind: action.kind,
    auditBase,
    operator,
  };
}

// 执行已 prepare 的 action：带 siteId/requestId 转发到模块，无论成败落一条审计。
export async function executeAction(
  prepared: PreparedAction,
  audit: AuditSink,
  request: ActionRequest,
  requestId: string,
  // 服务间共享密钥(x-kokoro-internal-secret)：模块侧 guard 校验;空串=部署未启用,不发头。
  internalSecret = "",
): Promise<unknown> {
  const headers: Record<string, string> = { "content-type": "application/json", "x-kokoro-request-id": requestId };
  if (request.siteId !== undefined) {
    headers["x-kokoro-site-id"] = request.siteId;
  }
  if (internalSecret.length > 0) {
    // 出站身份=admin：模块 route-access 校验 (caller=admin) ∧ (secret 匹配 admin)。
    headers["x-kokoro-service"] = "admin";
    headers["x-kokoro-internal-secret"] = internalSecret;
  }
  // operator principal 头：模块经 platform-kit readRequestContext 解析，审计归因到真实操作者(kind=operator)而非 system。
  headers["x-kokoro-principal"] = JSON.stringify({
    kind: "operator",
    operatorId: prepared.operator.id,
    roleKey: prepared.operator.roleKey,
  });

  let response: Response;
  try {
    response = await fetch(joinUrl(prepared.module.baseUrl, prepared.route), {
      method: prepared.method,
      headers,
      body: JSON.stringify(request.body ?? {}),
    });
  } catch (error) {
    await audit.record({ ...prepared.auditBase, result: "error", statusCode: 0, requestId });
    throw new GatewayError(error instanceof Error ? error.message : String(error), 502);
  }

  const body: unknown = await response.json().catch(() => null);
  await audit.record({ ...prepared.auditBase, result: response.ok ? "ok" : "error", statusCode: response.status, requestId });
  if (!response.ok) {
    throw new GatewayError(`upstream returned HTTP ${response.status}`, 502);
  }

  const unwrapped = actionResultSchema.safeParse(body);
  return unwrapped.success ? unwrapped.data.data : body;
}

// 写操作代理（守门人）：prepare(校验+鉴权) 后立即 execute(转发+审计)。
export async function proxyAction(
  modules: ModuleConfig[],
  audit: AuditSink,
  request: ActionRequest,
  requestId: string,
  operator: Operator,
): Promise<unknown> {
  const prepared = await prepareAction(modules, audit, request, requestId, operator);
  return executeAction(prepared, audit, request, requestId);
}

// 审批策略：dangerMutation 一律需审批；任何含金额(amountMicros)的 mutation 超阈值需审批（按 kind+金额数据驱动，不依赖具体 actionId，杜绝危险动作漏标）；其余直接执行。
export function needsApproval(
  kind: PreparedAction["kind"],
  request: ActionRequest,
  amountThresholdMicros: bigint,
): boolean {
  if (kind === "dangerMutation") {
    return true;
  }
  if (kind === "mutation") {
    const amount = readAmountMicros(request.body);
    return amount !== null && amount > amountThresholdMicros;
  }
  return false;
}

function readAmountMicros(body: unknown): bigint | null {
  if (typeof body !== "object" || body === null) {
    return null;
  }
  const raw = (body as Record<string, unknown>).amountMicros;
  if (typeof raw !== "string" || !/^\d+$/.test(raw)) {
    return null;
  }
  return BigInt(raw);
}

// 站点选择器数据源；按 operator 租户作用域过滤（超级权限见全部）。
export async function getSites(
  modules: ModuleConfig[],
  operator: Operator,
  internalSecret = "",
): Promise<ResourceRow[]> {
  const sites = await proxyResource(modules, "site", "/admin/sites", undefined, internalSecret);
  if (operator.scopeSites.includes("*")) {
    return sites;
  }
  return sites.filter((row) => typeof row.id === "string" && permitsSite(operator.scopeSites, row.id));
}

// 功能/页面可见性：只保留 operator 有权读的 resource/nav 及其有权执行的 action。
export function filterManifestForOperator(manifest: AdminModuleManifest, operator: Operator): AdminModuleManifest {
  return {
    ...manifest,
    navItems: manifest.navItems.filter((item) => permits(operator.permissions, item.requiredPermission)),
    resources: manifest.resources
      .filter((resource) => permits(operator.permissions, resource.requiredPermission))
      .map((resource) => ({
        ...resource,
        actions: resource.actions.filter((action) => permits(operator.permissions, action.requiredPermission)),
      })),
  };
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
export async function getUser360(
  modules: ModuleConfig[],
  query: User360Query,
  internalSecret = "",
): Promise<User360> {
  const [accounts, orders, users] = await Promise.all([
    proxyResource(modules, "credit", "/admin/credits/accounts", undefined, internalSecret).catch(() => [] as ResourceRow[]),
    proxyResource(modules, "payment", "/admin/payments/orders", undefined, internalSecret).catch(() => [] as ResourceRow[]),
    proxyResource(modules, "user", "/admin/users", undefined, internalSecret).catch(() => [] as ResourceRow[]),
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

// —— 运营台聚合总览（B2c）：聚合 credit + payment 的 stats 端点为一屏卡片数据。 ——
// 单对象聚合面（非表资源列表），故不走 proxyResource 的 manifest-资源校验；route 为网关内可信常量
// （非客户端输入,无 SSRF/开放代理风险,与 getUser360 硬编码 route 同信任级）。某模块离线/报错→该段 null,不拖垮整体。

const creditStatsSchema = z.object({
  accountsTotal: z.number(),
  accountsActive: z.number(),
  balanceSumMicros: z.string(),
  heldSumMicros: z.string(),
  grantedTotalMicros: z.string(),
  spentTotalMicros: z.string(),
});
const paymentStatsSchema = z.object({
  ordersTotal: z.number(),
  ordersPaid: z.number(),
  ordersPending: z.number(),
  ordersRefunded: z.number(),
  ordersCanceled: z.number(),
  revenueByCurrency: z.array(z.object({ currency: z.string(), amountMinor: z.string() })),
});
export type CreditStats = z.infer<typeof creditStatsSchema>;
export type PaymentStats = z.infer<typeof paymentStatsSchema>;

export interface BillingOverview {
  credit: CreditStats | null;
  payment: PaymentStats | null;
}

async function fetchStats<T>(
  modules: ModuleConfig[],
  moduleId: string,
  route: string,
  schema: z.ZodType<T>,
  internalSecret: string,
): Promise<T> {
  const module = modules.find((candidate) => candidate.id === moduleId);
  if (!module) {
    throw new GatewayError(`unknown module: ${moduleId}`, 400);
  }
  const response = await fetch(joinUrl(module.baseUrl, route), { headers: adminCallerHeaders(internalSecret) });
  if (!response.ok) {
    throw new GatewayError(`upstream returned HTTP ${response.status}`, 502);
  }
  const body: unknown = await response.json();
  return schema.parse(z.object({ data: z.unknown() }).parse(body).data);
}

export async function getBillingOverview(
  modules: ModuleConfig[],
  internalSecret = "",
): Promise<BillingOverview> {
  const [credit, payment] = await Promise.all([
    fetchStats(modules, "credit", "/admin/credits/stats", creditStatsSchema, internalSecret).catch(() => null),
    fetchStats(modules, "payment", "/admin/payments/stats", paymentStatsSchema, internalSecret).catch(() => null),
  ]);
  return { credit, payment };
}
