import { randomUUID } from "node:crypto";
import { readRequestContext, registerAdminManifestRoute, sendData, sendError, sendZodError } from "@kokoro/platform-kit";
import type { FastifyInstance, FastifyReply } from "fastify";
import { ZodError } from "zod";
import type { CreditService } from "../../application/credit-service.js";
import type { AccountAudit } from "../../domain/credit.js";
import { CreditAccountNotFoundError, InsufficientCreditError } from "../../domain/errors.js";
import type { CreditRepository } from "../../domain/repository.js";
import { creditAdminManifest } from "../admin/manifest.js";
import { auditAccountParamsSchema, grantCreditRequestSchema } from "./schemas.js";

export function registerCreditAdminRoutes(
  app: FastifyInstance,
  repository: CreditRepository,
  service: CreditService,
): void {
  registerAdminManifestRoute(app, creditAdminManifest);

  app.get("/admin/credits/accounts", async (_request, reply) =>
    sendData(reply, await repository.listAccounts()),
  );

  app.get("/admin/credits/ledger", async (_request, reply) =>
    sendData(reply, await repository.listLedgerEntries()),
  );

  app.get("/admin/credits/usage", async (_request, reply) =>
    sendData(reply, await repository.listUsageRecords()),
  );

  app.get("/admin/credits/pricing", async (_request, reply) =>
    sendData(reply, await repository.listPricingRules()),
  );

  // WHY: 管理员手动发积分；reason=refund 即退积分。idempotencyKey 服务端生成（管理员动作非客户端重放）。
  app.post("/admin/credits/grant", async (request, reply) => {
    try {
      const ctx = readRequestContext(request.headers);
      if (ctx.siteId === null) {
        return sendError(reply, 400, "credit.site_required", "缺少站点上下文", undefined, ctx.requestId);
      }
      const input = grantCreditRequestSchema.parse(request.body);
      const account = await service.ensureAccount({
        siteId: ctx.siteId,
        ownerKind: input.ownerKind,
        ownerId: input.ownerId,
      });
      const result = await service.grantCredits({
        accountId: account.id,
        amountMicros: input.amountMicros,
        idempotencyKey: randomUUID(),
        reason: input.reason,
      });
      return sendData(reply, result);
    } catch (error) {
      return handleAdminError(error, reply, "credit.admin_grant_failed");
    }
  });

  app.get("/admin/credits/accounts/:accountId/audit", async (request, reply) => {
    try {
      const { accountId } = auditAccountParamsSchema.parse(request.params);
      const account = await repository.getAccountById(accountId);
      if (!account) {
        throw new CreditAccountNotFoundError(accountId);
      }

      const [ledgerEntries, holds, usageRecords] = await Promise.all([
        repository.listLedgerByAccount(accountId),
        repository.listHoldsByAccount(accountId),
        repository.listUsageByAccount(accountId),
      ]);

      const audit: AccountAudit = { account, ledgerEntries, holds, usageRecords };
      return sendData(reply, audit);
    } catch (error) {
      return handleAdminError(error, reply, "credit.admin_audit_failed");
    }
  });
}

function handleAdminError(error: unknown, reply: FastifyReply, fallbackCode: string) {
  if (error instanceof ZodError) {
    return sendZodError(reply, error);
  }

  if (error instanceof InsufficientCreditError) {
    return sendError(reply, 402, "credit.insufficient", "积分余额不足");
  }

  if (error instanceof CreditAccountNotFoundError) {
    return sendError(reply, 404, "credit.account_not_found", "积分账户不存在");
  }

  return sendError(reply, 500, fallbackCode, "积分管理操作失败");
}
