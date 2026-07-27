import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { readRequestContext, registerHealthRoute, registerMetricsRoute, sendData, sendError } from "@kokoro/platform-kit";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { z } from "zod";
import type { PrismaClient } from "../generated/prisma/index.js";
import { queryAudit } from "./audit.js";
import type { ModuleConfig } from "./config.js";
import {
  executeAction,
  filterManifestForOperator,
  GatewayError,
  getBillingOverview,
  getManifests,
  getSites,
  getUser360,
  needsApproval,
  prepareAction,
  proxyResource,
  type ActionRequest,
  type AuditSink,
} from "./gateway.js";
import {
  ApprovalError,
  approveRequest,
  createApprovalRequest,
  listApprovals,
  rejectRequest,
  type ApprovalExecutionResult,
  type ApprovalStatusValue,
} from "./approval.js";
import { AuthError, type Authenticator } from "./auth.js";
import { registerAdminAuthConnect, type AdminAuthConnectConfig } from "./admin-auth-connect.js";
import {
  listOperators,
  listRoles,
  OperatorAuthError,
  permits,
  permitsSite,
  setOperatorStatus,
  upsertOperator,
  upsertRole,
  type Operator,
  type OperatorLookup,
} from "./rbac.js";

export interface AdminServerDeps {
  audit: AuditSink;
  resolveOperator: OperatorLookup;
  authenticate: Authenticator;
  prisma: PrismaClient;
  approvalGrantThresholdMicros: bigint;
  // 网关出站身份凭据：转发/拉 manifest/查资源时带 x-kokoro-service:admin + 此 secret（空串=未启用，dev 直通）。
  internalSecret?: string;
  adminAuth?: AdminAuthConnectConfig;
}

const approvalsQuerySchema = z
  .object({
    status: z.enum(["pending", "approved", "rejected", "executed", "failed"]).optional(),
    siteId: z.string().min(1).optional(),
  })
  .strict();

const approvalRejectBodySchema = z.object({ note: z.string().min(1).optional() }).strict();
const approvalParamsSchema = z.object({ id: z.string().min(1) });

const resourceQuerySchema = z.object({
  moduleId: z.string().min(1),
  route: z.string().min(1),
  siteId: z.string().min(1).optional(),
});

const user360QuerySchema = z
  .object({
    siteId: z.string().min(1),
    ownerKind: z.enum(["user", "team"]),
    ownerId: z.string().min(1),
  })
  .strict();

const actionBodySchema = z
  .object({
    moduleId: z.string().min(1),
    resourceId: z.string().min(1),
    actionId: z.string().min(1),
    params: z.record(z.string()).optional(),
    body: z.unknown().optional(),
    siteId: z.string().min(1).optional(),
    reason: z.string().min(1).optional(),
  })
  .strict();

const auditQuerySchema = z
  .object({
    siteId: z.string().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict();

const roleBodySchema = z
  .object({
    key: z.string().min(1),
    name: z.string().min(1),
    permissions: z.array(z.string()),
  })
  .strict();

const operatorBodySchema = z
  .object({
    email: z.string().min(1),
    displayName: z.string().min(1),
    roleKey: z.string().min(1),
    scopeSites: z.array(z.string()),
  })
  .strict();

const operatorStatusBodySchema = z
  .object({
    status: z.enum(["active", "disabled"]),
  })
  .strict();

const operatorParamsSchema = z.object({ id: z.string().min(1) });

const indexHtmlPath = fileURLToPath(new URL("../public/index.html", import.meta.url));

export function createAdminServer(modules: ModuleConfig[], deps: AdminServerDeps): FastifyInstance {
  const app = Fastify({ logger: false });

  registerHealthRoute(app, "kokoro-platform-admin");
  registerMetricsRoute(app, "kokoro-platform-admin");
  if (deps.adminAuth !== undefined) registerAdminAuthConnect(app, deps.adminAuth);

  app.get("/", async (_request, reply) => {
    const html = await readFile(indexHtmlPath, "utf8");
    return reply.code(200).type("text/html").send(html);
  });

  const requireOperator = async (request: FastifyRequest, reply: FastifyReply): Promise<Operator | undefined> => {
    try {
      const email = await deps.authenticate(request);
      return await deps.resolveOperator(email);
    } catch (error) {
      if (error instanceof AuthError || error instanceof OperatorAuthError) {
        await sendError(reply, error.statusCode, "operator.auth", error.message);
        return undefined;
      }
      throw error;
    }
  };

  // 当前操作员的能力面：UI 据此决定可见功能/页面/操作（服务端仍二次强制）。
  app.get("/api/me", async (request, reply) => {
    const operator = await requireOperator(request, reply);
    if (!operator) return reply;
    return sendData(reply, {
      email: operator.email,
      roleKey: operator.roleKey,
      permissions: operator.permissions,
      scopeSites: operator.scopeSites,
    });
  });

  app.get("/api/manifests", async (request, reply) => {
    const operator = await requireOperator(request, reply);
    if (!operator) return reply;
    const all = await getManifests(modules, deps.internalSecret ?? "");
    const scoped = all.map((status) =>
      status.online ? { ...status, manifest: filterManifestForOperator(status.manifest, operator) } : status,
    );
    return sendData(reply, scoped);
  });

  app.get("/api/operators", async (request, reply) => {
    const operator = await requireOperator(request, reply);
    if (!operator) return reply;
    if (!permits(operator.permissions, "operator.read")) {
      return sendError(reply, 403, "operator.auth", "无权查看操作员列表");
    }
    return sendData(reply, await listOperators(deps.prisma));
  });

  app.get("/api/roles", async (request, reply) => {
    const operator = await requireOperator(request, reply);
    if (!operator) return reply;
    if (!permits(operator.permissions, "operator.manage")) {
      return sendError(reply, 403, "operator.auth", "无权管理权限");
    }
    return sendData(reply, await listRoles(deps.prisma));
  });

  app.post("/api/roles", async (request, reply) => {
    const operator = await requireOperator(request, reply);
    if (!operator) return reply;
    if (!permits(operator.permissions, "operator.manage")) {
      return sendError(reply, 403, "operator.auth", "无权管理权限");
    }
    const parsed = roleBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return sendError(reply, 400, "request.invalid", "无效的角色定义", { issues: parsed.error.issues });
    }
    return sendData(reply, await upsertRole(deps.prisma, parsed.data));
  });

  app.post("/api/operators", async (request, reply) => {
    const operator = await requireOperator(request, reply);
    if (!operator) return reply;
    if (!permits(operator.permissions, "operator.manage")) {
      return sendError(reply, 403, "operator.auth", "无权管理操作员");
    }
    const parsed = operatorBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return sendError(reply, 400, "request.invalid", "无效的操作员定义", { issues: parsed.error.issues });
    }
    return sendData(reply, await upsertOperator(deps.prisma, parsed.data));
  });

  app.post("/api/operators/:id/status", async (request, reply) => {
    const operator = await requireOperator(request, reply);
    if (!operator) return reply;
    if (!permits(operator.permissions, "operator.manage")) {
      return sendError(reply, 403, "operator.auth", "无权管理操作员");
    }
    const params = operatorParamsSchema.safeParse(request.params);
    if (!params.success) {
      return sendError(reply, 400, "request.invalid", "无效的操作员 id", { issues: params.error.issues });
    }
    const parsed = operatorStatusBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return sendError(reply, 400, "request.invalid", "无效的状态", { issues: parsed.error.issues });
    }
    return sendData(reply, await setOperatorStatus(deps.prisma, params.data.id, parsed.data.status));
  });

  app.get("/api/sites", async (request, reply) => {
    const operator = await requireOperator(request, reply);
    if (!operator) return reply;
    try {
      return sendData(reply, await getSites(modules, operator, deps.internalSecret ?? ""));
    } catch (error) {
      if (error instanceof GatewayError) {
        return sendError(reply, error.statusCode, "gateway.error", error.message);
      }
      return sendError(reply, 502, "gateway.error", error instanceof Error ? error.message : String(error));
    }
  });

  // 运营台总览（B2c）：聚合 credit + payment stats 为一屏卡片。需登录操作员；模块离线段降级 null。
  app.get("/api/billing-overview", async (request, reply) => {
    const operator = await requireOperator(request, reply);
    if (!operator) return reply;
    try {
      return sendData(reply, await getBillingOverview(modules, deps.internalSecret ?? ""));
    } catch (error) {
      if (error instanceof GatewayError) {
        return sendError(reply, error.statusCode, "gateway.error", error.message);
      }
      return sendError(reply, 502, "gateway.error", error instanceof Error ? error.message : String(error));
    }
  });

  app.get("/api/user360", async (request, reply) => {
    const operator = await requireOperator(request, reply);
    if (!operator) return reply;
    const query = user360QuerySchema.safeParse(request.query);
    if (!query.success) {
      return sendError(reply, 400, "request.invalid", "无效的查询参数", { issues: query.error.issues });
    }
    if (!permitsSite(operator.scopeSites, query.data.siteId)) {
      return sendError(reply, 403, "operator.auth", "租户超出作用域");
    }
    return sendData(reply, await getUser360(modules, query.data, deps.internalSecret ?? ""));
  });

  app.get("/api/resource", async (request, reply) => {
    const operator = await requireOperator(request, reply);
    if (!operator) return reply;
    const query = resourceQuerySchema.safeParse(request.query);
    if (!query.success) {
      return sendError(reply, 400, "request.invalid", "无效的查询参数", { issues: query.error.issues });
    }
    try {
      const rows = await proxyResource(
        modules,
        query.data.moduleId,
        query.data.route,
        {
          operator,
          ...(query.data.siteId === undefined ? {} : { siteId: query.data.siteId }),
        },
        deps.internalSecret ?? "",
      );
      return sendData(reply, rows);
    } catch (error) {
      if (error instanceof GatewayError) {
        return sendError(reply, error.statusCode, "gateway.error", error.message);
      }
      return sendError(reply, 502, "gateway.error", error instanceof Error ? error.message : String(error));
    }
  });

  app.post("/api/action", async (request, reply) => {
    const parsed = actionBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return sendError(reply, 400, "request.invalid", "无效的操作请求", { issues: parsed.error.issues });
    }
    const ctx = readRequestContext(request.headers);
    let operator: Operator;
    try {
      const email = await deps.authenticate(request);
      operator = await deps.resolveOperator(email);
    } catch (error) {
      if (error instanceof AuthError || error instanceof OperatorAuthError) {
        return sendError(reply, error.statusCode, "operator.auth", error.message, undefined, ctx.requestId);
      }
      throw error;
    }
    // 条件 spread 丢掉 undefined 键，匹配 exactOptionalPropertyTypes 下的 ActionRequest。
    const data = parsed.data;
    const actionRequest: ActionRequest = {
      moduleId: data.moduleId,
      resourceId: data.resourceId,
      actionId: data.actionId,
      ...(data.params === undefined ? {} : { params: data.params }),
      ...(data.body === undefined ? {} : { body: data.body }),
      ...(data.siteId === undefined ? {} : { siteId: data.siteId }),
      ...(data.reason === undefined ? {} : { reason: data.reason }),
    };
    try {
      // 先 prepare(解析+鉴权+理由)；据 action 种类/金额判定是否需二次审批。
      const prepared = await prepareAction(modules, deps.audit, actionRequest, ctx.requestId, operator, deps.internalSecret ?? "");
      if (needsApproval(prepared.kind, actionRequest, deps.approvalGrantThresholdMicros)) {
        const approval = await createApprovalRequest(deps.prisma, {
          request: actionRequest,
          requiredPermission: prepared.requiredPermission,
          operator,
        });
        await deps.audit.record({
          ...prepared.auditBase,
          result: "ok",
          statusCode: 202,
          requestId: ctx.requestId,
        });
        return sendData(reply, { pendingApproval: true, approvalId: approval.id }, 202, ctx.requestId);
      }
      const result = await executeAction(prepared, deps.audit, actionRequest, ctx.requestId, deps.internalSecret ?? "");
      return sendData(reply, result, 200, ctx.requestId);
    } catch (error) {
      if (error instanceof GatewayError) {
        return sendError(reply, error.statusCode, "gateway.error", error.message, undefined, ctx.requestId);
      }
      return sendError(reply, 502, "gateway.error", error instanceof Error ? error.message : String(error), undefined, ctx.requestId);
    }
  });

  app.get("/api/approvals", async (request, reply) => {
    const operator = await requireOperator(request, reply);
    if (!operator) return reply;
    if (!permits(operator.permissions, "approval.read")) {
      return sendError(reply, 403, "operator.auth", "无权查看审批");
    }
    const query = approvalsQuerySchema.safeParse(request.query);
    if (!query.success) {
      return sendError(reply, 400, "request.invalid", "无效的查询参数", { issues: query.error.issues });
    }
    const filter: { status?: ApprovalStatusValue; siteId?: string } = {
      ...(query.data.status === undefined ? {} : { status: query.data.status }),
      ...(query.data.siteId === undefined ? {} : { siteId: query.data.siteId }),
    };
    if (filter.siteId !== undefined && !permitsSite(operator.scopeSites, filter.siteId)) {
      return sendError(reply, 403, "operator.auth", "租户超出作用域");
    }
    return sendData(reply, await listApprovals(deps.prisma, operator, filter));
  });

  app.post("/api/approvals/:id/approve", async (request, reply) => {
    const operator = await requireOperator(request, reply);
    if (!operator) return reply;
    const params = approvalParamsSchema.safeParse(request.params);
    if (!params.success) {
      return sendError(reply, 400, "request.invalid", "无效的审批 id", { issues: params.error.issues });
    }
    const ctx = readRequestContext(request.headers);
    // 复核执行：以 checker 身份原样重跑（prepare 会再校验权限/作用域并审计执行）。
    const execute = async (held: ActionRequest): Promise<ApprovalExecutionResult> => {
      try {
        const prepared = await prepareAction(modules, deps.audit, held, ctx.requestId, operator, deps.internalSecret ?? "");
        await executeAction(prepared, deps.audit, held, ctx.requestId, deps.internalSecret ?? "");
        return { statusCode: 200 };
      } catch (error) {
        if (error instanceof GatewayError) {
          return { statusCode: error.statusCode, error: error.message };
        }
        return { statusCode: 502, error: error instanceof Error ? error.message : String(error) };
      }
    };
    try {
      return sendData(reply, await approveRequest(deps.prisma, params.data.id, operator, execute));
    } catch (error) {
      if (error instanceof ApprovalError) {
        return sendError(reply, error.statusCode, "approval.error", error.message);
      }
      throw error;
    }
  });

  app.post("/api/approvals/:id/reject", async (request, reply) => {
    const operator = await requireOperator(request, reply);
    if (!operator) return reply;
    const params = approvalParamsSchema.safeParse(request.params);
    if (!params.success) {
      return sendError(reply, 400, "request.invalid", "无效的审批 id", { issues: params.error.issues });
    }
    const body = approvalRejectBodySchema.safeParse(request.body ?? {});
    if (!body.success) {
      return sendError(reply, 400, "request.invalid", "无效的驳回理由", { issues: body.error.issues });
    }
    try {
      return sendData(reply, await rejectRequest(deps.prisma, params.data.id, operator, body.data.note));
    } catch (error) {
      if (error instanceof ApprovalError) {
        return sendError(reply, error.statusCode, "approval.error", error.message);
      }
      throw error;
    }
  });

  app.get("/api/audit", async (request, reply) => {
    const operator = await requireOperator(request, reply);
    if (!operator) return reply;
    if (!permits(operator.permissions, "audit.read")) {
      return sendError(reply, 403, "operator.auth", "无权查看审计");
    }
    const query = auditQuerySchema.safeParse(request.query);
    if (!query.success) {
      return sendError(reply, 400, "request.invalid", "无效的查询参数", { issues: query.error.issues });
    }
    const { siteId, limit } = query.data;
    if (siteId === undefined) {
      // 无 siteId = 跨租户全量，仅超级权限可看。
      if (!operator.scopeSites.includes("*")) {
        return sendError(reply, 403, "operator.auth", "请指定本作用域内的站点");
      }
      return sendData(reply, await queryAudit(deps.prisma, { limit }));
    }
    if (!permitsSite(operator.scopeSites, siteId)) {
      return sendError(reply, 403, "operator.auth", "租户超出作用域");
    }
    return sendData(reply, await queryAudit(deps.prisma, { siteId, limit }));
  });

  return app;
}
