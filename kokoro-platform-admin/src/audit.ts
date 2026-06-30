import type { PrismaClient } from "../generated/prisma/index.js";
import type { AuditEntry, AuditSink } from "./gateway.js";

// 运营审计持久化：每个动作（含被拒）落 audit_logs，不可篡改、可追溯。
export class PrismaAuditSink implements AuditSink {
  constructor(private readonly prisma: PrismaClient) {}

  async record(entry: AuditEntry): Promise<void> {
    await this.prisma.auditLog.create({
      data: {
        actorOperatorId: entry.actorOperatorId ?? null,
        actorEmail: entry.actorEmail ?? null,
        moduleId: entry.moduleId,
        resourceId: entry.resourceId,
        actionId: entry.actionId,
        targetRoute: entry.targetRoute,
        siteId: entry.siteId ?? null,
        reason: entry.reason ?? null,
        result: entry.result,
        statusCode: entry.statusCode,
        requestId: entry.requestId,
      },
    });
  }
}

export interface AuditQuery {
  siteId?: string;
  limit: number;
}

export function queryAudit(prisma: PrismaClient, query: AuditQuery) {
  return prisma.auditLog.findMany({
    where: query.siteId === undefined ? {} : { siteId: query.siteId },
    orderBy: { createdAt: "desc" },
    take: query.limit,
  });
}
