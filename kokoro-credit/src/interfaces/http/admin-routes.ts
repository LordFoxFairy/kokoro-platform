import { randomUUID } from "node:crypto";
import {
  AppError,
  readRequestContext,
  registerAdminManifestRoute,
  sendData,
  sendError,
  sendZodError,
} from "@kokoro/platform-kit";
import type { FastifyInstance, FastifyReply } from "fastify";
import { ZodError } from "zod";
import type { CreditService } from "../../application/credit-service.js";
import type { AccountAudit } from "../../domain/credit.js";
import { isCreditLifecycleError } from "../../domain/credit-lifecycle.js";
import { CreditAccountNotFoundError, InsufficientCreditError } from "../../domain/errors.js";
import type { CreditRepository } from "../../domain/repository.js";
import { creditAdminManifest } from "../admin/manifest.js";
import {
  accountParamsSchema,
  auditAccountParamsSchema,
  createPricingRuleRequestSchema,
  deleteRequestSchema,
  grantCreditRequestSchema,
  pricingRuleParamsSchema,
  setAccountQuotaRequestSchema,
} from "./schemas.js";

export function registerCreditAdminRoutes(
  app: FastifyInstance,
  repository: CreditRepository,
  service: CreditService,
): void {
  registerAdminManifestRoute(app, creditAdminManifest);

  app.get("/admin/credits/accounts", async (_request, reply) =>
    sendData(reply, await repository.listAccounts(undefined, { includeDeleted: true })),
  );

  app.get("/admin/credits/ledger", async (_request, reply) =>
    sendData(reply, await repository.listLedgerEntries()),
  );

  app.get("/admin/credits/usage", async (_request, reply) =>
    sendData(reply, await repository.listUsageRecords()),
  );

  app.get("/admin/credits/pricing", async (_request, reply) =>
    sendData(reply, await repository.listPricingRules({ includeDeleted: true })),
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

  // WHY: 管理员设组织级消费配额；quotaMicros=null 清除（回退不限），周期 V1 仅 monthly。
  app.post("/admin/credits/accounts/:accountId/quota", async (request, reply) => {
    try {
      const { accountId } = accountParamsSchema.parse(request.params);
      const input = setAccountQuotaRequestSchema.parse(request.body);
      const result = await service.setAccountQuota({
        accountId,
        quotaMicros: input.quotaMicros,
        quotaPeriod: input.quotaPeriod ?? "monthly",
      });
      return sendData(reply, result);
    } catch (error) {
      return handleAdminError(error, reply, "credit.admin_set_quota_failed");
    }
  });

  app.delete("/admin/credits/accounts/:accountId", async (request, reply) => {
    try {
      const { accountId } = accountParamsSchema.parse(request.params);
      const input = deleteRequestSchema.parse(request.body);
      const result = await service.deleteAccount({ id: accountId, deletedBy: input.deletedBy, reason: input.reason });
      return sendData(reply, result);
    } catch (error) {
      return handleAdminError(error, reply, "credit.admin_account_delete_failed");
    }
  });

  app.post("/admin/credits/accounts/:accountId/restore", async (request, reply) => {
    try {
      const { accountId } = accountParamsSchema.parse(request.params);
      const result = await service.restoreAccount({ id: accountId });
      return sendData(reply, result);
    } catch (error) {
      return handleAdminError(error, reply, "credit.admin_account_restore_failed");
    }
  });

  app.post("/admin/credits/pricing-rules", async (request, reply) => {
    try {
      const input = createPricingRuleRequestSchema.parse(request.body);
      const result = await service.createPricingRule(input);
      return sendData(reply, result);
    } catch (error) {
      return handleAdminError(error, reply, "credit.admin_pricing_rule_create_failed");
    }
  });

  app.delete("/admin/credits/pricing-rules/:pricingRuleId", async (request, reply) => {
    try {
      const { pricingRuleId } = pricingRuleParamsSchema.parse(request.params);
      const input = deleteRequestSchema.parse(request.body);
      const result = await service.deletePricingRule({
        id: pricingRuleId,
        deletedBy: input.deletedBy,
        reason: input.reason,
      });
      return sendData(reply, result);
    } catch (error) {
      return handleAdminError(error, reply, "credit.admin_pricing_rule_delete_failed");
    }
  });

  app.post("/admin/credits/pricing-rules/:pricingRuleId/restore", async (request, reply) => {
    try {
      const { pricingRuleId } = pricingRuleParamsSchema.parse(request.params);
      const result = await service.restorePricingRule({ id: pricingRuleId });
      return sendData(reply, result);
    } catch (error) {
      return handleAdminError(error, reply, "credit.admin_pricing_rule_restore_failed");
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

  if (isCreditLifecycleError(error)) {
    return sendError(reply, error.statusCode, error.code, error.message);
  }

  if (error instanceof AppError) {
    return sendError(reply, error.httpStatus, error.code, error.message, error.details);
  }

  if (error instanceof InsufficientCreditError) {
    return sendError(reply, 402, "credit.insufficient", "积分余额不足");
  }

  if (error instanceof CreditAccountNotFoundError) {
    return sendError(reply, 404, "credit.account_not_found", "积分账户不存在");
  }

  return sendError(reply, 500, fallbackCode, "积分管理操作失败");
}
