import { randomUUID } from "node:crypto";
import { z } from "zod";
import { Prisma, type PrismaClient } from "../generated/prisma/index.js";
import type { ActionRequest } from "./gateway.js";
import { permits, permitsSite, type Operator } from "./rbac.js";

export class ApprovalError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = "ApprovalError";
  }
}

export type ApprovalStatusValue = "pending" | "approved" | "rejected" | "executed" | "failed";

// 执行回调返回上游状态码；statusCode<400 视为成功执行。
export interface ApprovalExecutionResult {
  statusCode: number;
  error?: string;
}
export type ApprovalExecutor = (request: ActionRequest) => Promise<ApprovalExecutionResult>;

const jsonValueSchema: z.ZodType<Prisma.InputJsonValue> = z.lazy(() => {
  const nullable = z.union([jsonValueSchema, z.null()]);
  return z.union([z.string(), z.number(), z.boolean(), z.array(nullable), z.record(nullable)]);
});

// 客户端 JSON → Prisma 入参；缺省存 SQL NULL(DbNull)。序列化再洗，杜绝 cast。
function toJson(value: unknown): Prisma.InputJsonValue | typeof Prisma.DbNull {
  if (value === undefined || value === null) {
    return Prisma.DbNull;
  }
  return jsonValueSchema.parse(JSON.parse(JSON.stringify(value)));
}

const paramsSchema = z.record(z.string());

export interface CreateApprovalInput {
  request: ActionRequest;
  requiredPermission: string;
  operator: Operator;
}

export function createApprovalRequest(prisma: PrismaClient, input: CreateApprovalInput) {
  const { request, requiredPermission, operator } = input;
  return prisma.approvalRequest.create({
    data: {
      moduleId: request.moduleId,
      resourceId: request.resourceId,
      actionId: request.actionId,
      params: toJson(request.params),
      body: toJson(request.body),
      siteId: request.siteId ?? null,
      reason: request.reason ?? null,
      requiredPermission,
      executionKey: randomUUID(),
      requestedById: operator.id,
      requestedByEmail: operator.email,
    },
  });
}

export function listApprovals(
  prisma: PrismaClient,
  operator: Operator,
  filter: { status?: ApprovalStatusValue; siteId?: string },
) {
  const where: Prisma.ApprovalRequestWhereInput = {};
  if (filter.status !== undefined) {
    where.status = filter.status;
  }
  if (filter.siteId !== undefined) {
    where.siteId = filter.siteId;
  } else if (!operator.scopeSites.includes("*")) {
    // 非超级权限只看自己作用域内站点的审批。
    where.siteId = { in: operator.scopeSites };
  }
  return prisma.approvalRequest.findMany({ where, orderBy: { requestedAt: "desc" }, take: 100 });
}

function reconstructRequest(row: {
  moduleId: string;
  resourceId: string;
  actionId: string;
  params: Prisma.JsonValue;
  body: Prisma.JsonValue;
  siteId: string | null;
  reason: string | null;
}): ActionRequest {
  const params = row.params === null ? undefined : paramsSchema.parse(row.params);
  return {
    moduleId: row.moduleId,
    resourceId: row.resourceId,
    actionId: row.actionId,
    ...(params === undefined ? {} : { params }),
    ...(row.body === null ? {} : { body: row.body }),
    ...(row.siteId === null ? {} : { siteId: row.siteId }),
    ...(row.reason === null ? {} : { reason: row.reason }),
  };
}

function assertChecker(
  row: { requestedById: string; requiredPermission: string; siteId: string | null },
  checker: Operator,
): void {
  if (row.requestedById === checker.id) {
    throw new ApprovalError("cannot decide your own request", 403);
  }
  if (!permits(checker.permissions, row.requiredPermission)) {
    throw new ApprovalError(`permission denied: ${row.requiredPermission}`, 403);
  }
  if (row.siteId !== null && !permitsSite(checker.scopeSites, row.siteId)) {
    throw new ApprovalError("tenant out of scope", 403);
  }
}

export async function approveRequest(prisma: PrismaClient, id: string, checker: Operator, execute: ApprovalExecutor) {
  const existing = await prisma.approvalRequest.findUnique({ where: { id } });
  if (!existing) {
    throw new ApprovalError(`approval not found: ${id}`, 404);
  }
  if (existing.status !== "pending") {
    // 幂等：已决，返回当前态，绝不二次执行。
    return existing;
  }
  assertChecker(existing, checker);

  // 原子条件转移 pending→approved：count=0(并发败者/已决)则不执行，保证至多一次执行。
  const claimed = await prisma.approvalRequest.updateMany({
    where: { id, status: "pending" },
    data: { status: "approved", decidedById: checker.id, decidedByEmail: checker.email, decidedAt: new Date() },
  });
  if (claimed.count === 0) {
    return prisma.approvalRequest.findUniqueOrThrow({ where: { id } });
  }

  const result = await execute(reconstructRequest(existing));
  const ok = result.statusCode >= 200 && result.statusCode < 400;
  return prisma.approvalRequest.update({
    where: { id },
    data: {
      status: ok ? "executed" : "failed",
      resultStatusCode: result.statusCode,
      executedAt: new Date(),
      error: result.error ?? null,
    },
  });
}

export async function rejectRequest(prisma: PrismaClient, id: string, checker: Operator, note?: string) {
  const existing = await prisma.approvalRequest.findUnique({ where: { id } });
  if (!existing) {
    throw new ApprovalError(`approval not found: ${id}`, 404);
  }
  if (existing.status !== "pending") {
    return existing;
  }
  assertChecker(existing, checker);

  await prisma.approvalRequest.updateMany({
    where: { id, status: "pending" },
    data: {
      status: "rejected",
      decidedById: checker.id,
      decidedByEmail: checker.email,
      decidedAt: new Date(),
      ...(note === undefined ? {} : { decisionNote: note }),
    },
  });
  return prisma.approvalRequest.findUniqueOrThrow({ where: { id } });
}
