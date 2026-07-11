import {
  AppError,
  jsonSchema,
  readRequestContext,
  registerHealthRoute,
  sendData,
  sendError,
  sendZodError,
} from "@kokoro/platform-kit";
import type { FastifyInstance, FastifyReply } from "fastify";
import { ZodError } from "zod";
import type { CreditService } from "../../application/credit-service.js";
import {
  CreditAccountNotFoundError,
  CreditCaptureExceedsHoldError,
  CreditHoldNotActiveError,
  CreditHoldNotFoundError,
  InsufficientCreditError,
  PricingRuleNotFoundError,
} from "../../domain/errors.js";
import { isCreditLifecycleError } from "../../domain/credit-lifecycle.js";
import {
  accountParamsSchema,
  captureCreditRequestSchema,
  createPricingRuleRequestSchema,
  creditMutationRequestSchema,
  deleteRequestSchema,
  ensureCreditAccountRequestSchema,
  type EnsureCreditAccountResponse,
  holdCreditRequestSchema,
  pricingRuleParamsSchema,
  quoteRequestSchema,
  releaseCreditRequestSchema,
  usageHoldRequestSchema,
  usageSettleRequestSchema,
} from "./schemas.js";

export function registerCreditRoutes(app: FastifyInstance, service: CreditService): void {
  registerHealthRoute(app, "credit");

  app.post("/credit/accounts/ensure", {
    schema: {
      tags: ["credit"],
      summary: "确保积分账户存在（不存在则创建）",
      body: jsonSchema(ensureCreditAccountRequestSchema),
    },
  }, async (request, reply) => {
    try {
      const ctx = readRequestContext(request.headers);
      if (ctx.siteId === null) {
        return sendError(reply, 400, "credit.site_required", "缺少站点上下文", undefined, ctx.requestId);
      }
      const input = ensureCreditAccountRequestSchema.parse(request.body);
      const result = await service.ensureAccount({ siteId: ctx.siteId, ...input });
      // satisfies 把响应钉在对外最小契约上：id 字段漂移在本包 typecheck 先红。
      return sendData(reply, result satisfies EnsureCreditAccountResponse);
    } catch (error) {
      return handleCreditError(error, reply, "credit.account_ensure_failed");
    }
  });

  app.delete("/credit/accounts/:accountId", {
    schema: {
      tags: ["credit"],
      summary: "删除积分账户",
      params: jsonSchema(accountParamsSchema),
      body: jsonSchema(deleteRequestSchema),
    },
  }, async (request, reply) => {
    try {
      const { accountId } = accountParamsSchema.parse(request.params);
      const input = deleteRequestSchema.parse(request.body);
      const result = await service.deleteAccount({ id: accountId, deletedBy: input.deletedBy, reason: input.reason });
      return sendData(reply, result);
    } catch (error) {
      return handleCreditError(error, reply, "credit.account_delete_failed");
    }
  });

  app.post("/credit/accounts/:accountId/restore", {
    schema: {
      tags: ["credit"],
      summary: "恢复积分账户",
      params: jsonSchema(accountParamsSchema),
    },
  }, async (request, reply) => {
    try {
      const { accountId } = accountParamsSchema.parse(request.params);
      const result = await service.restoreAccount({ id: accountId });
      return sendData(reply, result);
    } catch (error) {
      return handleCreditError(error, reply, "credit.account_restore_failed");
    }
  });

  app.post("/credit/grant", {
    schema: {
      tags: ["credit"],
      summary: "向账户发放积分",
      body: jsonSchema(creditMutationRequestSchema),
    },
  }, async (request, reply) => {
    try {
      const input = creditMutationRequestSchema.parse(request.body);
      const result = await service.grantCredits(input);
      return sendData(reply, result);
    } catch (error) {
      return handleCreditError(error, reply, "credit.grant_failed");
    }
  });

  app.post("/credit/spend", {
    schema: {
      tags: ["credit"],
      summary: "从账户扣除积分",
      body: jsonSchema(creditMutationRequestSchema),
    },
  }, async (request, reply) => {
    try {
      const input = creditMutationRequestSchema.parse(request.body);
      const result = await service.spendCredits(input);
      return sendData(reply, result);
    } catch (error) {
      return handleCreditError(error, reply, "credit.spend_failed");
    }
  });

  app.post("/credit/hold", {
    schema: {
      tags: ["credit"],
      summary: "冻结积分额度",
      body: jsonSchema(holdCreditRequestSchema),
    },
  }, async (request, reply) => {
    try {
      const input = holdCreditRequestSchema.parse(request.body);
      const result = await service.holdCredits(input);
      return sendData(reply, result);
    } catch (error) {
      return handleCreditError(error, reply, "credit.hold_failed");
    }
  });

  app.post("/credit/capture", {
    schema: {
      tags: ["credit"],
      summary: "结算冻结额度（实际扣费）",
      body: jsonSchema(captureCreditRequestSchema),
    },
  }, async (request, reply) => {
    try {
      const input = captureCreditRequestSchema.parse(request.body);
      const result = await service.captureHold(input);
      return sendData(reply, result);
    } catch (error) {
      return handleCreditError(error, reply, "credit.capture_failed");
    }
  });

  app.post("/credit/usage/hold", {
    schema: {
      tags: ["credit"],
      summary: "run 受理冻结（按 pricing 预估用量算冻结额）",
      body: jsonSchema(usageHoldRequestSchema),
    },
  }, async (request, reply) => {
    try {
      const ctx = readRequestContext(request.headers);
      if (ctx.siteId === null) {
        return sendError(reply, 400, "credit.site_required", "缺少站点上下文", undefined, ctx.requestId);
      }
      const input = usageHoldRequestSchema.parse(request.body);
      const result = await service.holdForUsage({ siteId: ctx.siteId, ...input });
      return sendData(reply, result);
    } catch (error) {
      return handleCreditError(error, reply, "credit.usage_hold_failed");
    }
  });

  app.post("/credit/usage/settle", {
    schema: {
      tags: ["credit"],
      summary: "run 终态结算（按 token 用量复算实额，clamp 到冻结额）",
      body: jsonSchema(usageSettleRequestSchema),
    },
  }, async (request, reply) => {
    try {
      const input = usageSettleRequestSchema.parse(request.body);
      const result = await service.settleUsage({
        holdId: input.holdId,
        inputTokens: String(input.usage.inputTokens),
        outputTokens: String(input.usage.outputTokens),
        idempotencyKey: input.idempotencyKey,
      });
      return sendData(reply, result);
    } catch (error) {
      return handleCreditError(error, reply, "credit.usage_settle_failed");
    }
  });

  app.post("/credit/quote", {
    schema: {
      tags: ["credit"],
      summary: "按计价规则报价",
      body: jsonSchema(quoteRequestSchema),
    },
  }, async (request, reply) => {
    try {
      const input = quoteRequestSchema.parse(request.body);
      const result = await service.quote(input);
      return sendData(reply, result);
    } catch (error) {
      return handleCreditError(error, reply, "credit.quote_failed");
    }
  });

  app.post("/credit/pricing-rules", {
    schema: {
      tags: ["credit"],
      summary: "创建计价规则",
      body: jsonSchema(createPricingRuleRequestSchema),
    },
  }, async (request, reply) => {
    try {
      const input = createPricingRuleRequestSchema.parse(request.body);
      const result = await service.createPricingRule(input);
      return sendData(reply, result);
    } catch (error) {
      return handleCreditError(error, reply, "credit.pricing_rule_create_failed");
    }
  });

  app.delete("/credit/pricing-rules/:pricingRuleId", {
    schema: {
      tags: ["credit"],
      summary: "删除计价规则",
      params: jsonSchema(pricingRuleParamsSchema),
      body: jsonSchema(deleteRequestSchema),
    },
  }, async (request, reply) => {
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
      return handleCreditError(error, reply, "credit.pricing_rule_delete_failed");
    }
  });

  app.post("/credit/pricing-rules/:pricingRuleId/restore", {
    schema: {
      tags: ["credit"],
      summary: "恢复计价规则",
      params: jsonSchema(pricingRuleParamsSchema),
    },
  }, async (request, reply) => {
    try {
      const { pricingRuleId } = pricingRuleParamsSchema.parse(request.params);
      const result = await service.restorePricingRule({ id: pricingRuleId });
      return sendData(reply, result);
    } catch (error) {
      return handleCreditError(error, reply, "credit.pricing_rule_restore_failed");
    }
  });

  app.post("/credit/holds/sweep", {
    schema: {
      tags: ["credit"],
      summary: "回收已过期的悬挂冻结（运维/测试手动触发；定时 sweeper 亦调此逻辑）",
    },
  }, async (_request, reply) => {
    try {
      const reclaimed = await service.sweepExpiredHolds();
      return sendData(reply, { reclaimed });
    } catch (error) {
      return handleCreditError(error, reply, "credit.holds_sweep_failed");
    }
  });

  app.post("/credit/release", {
    schema: {
      tags: ["credit"],
      summary: "释放冻结额度",
      body: jsonSchema(releaseCreditRequestSchema),
    },
  }, async (request, reply) => {
    try {
      const input = releaseCreditRequestSchema.parse(request.body);
      const result = await service.releaseHold(input);
      return sendData(reply, result);
    } catch (error) {
      return handleCreditError(error, reply, "credit.release_failed");
    }
  });
}

function handleCreditError(error: unknown, reply: FastifyReply, fallbackCode: string) {
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

  if (error instanceof CreditHoldNotFoundError) {
    return sendError(reply, 404, "credit.hold_not_found", "冻结记录不存在");
  }

  if (error instanceof PricingRuleNotFoundError) {
    return sendError(reply, 404, "credit.pricing_rule_not_found", "计价规则不存在");
  }

  if (error instanceof CreditCaptureExceedsHoldError) {
    return sendError(reply, 400, "credit.capture_exceeds_hold", "结算金额超过冻结额度");
  }

  if (error instanceof CreditHoldNotActiveError) {
    return sendError(reply, 400, "credit.hold_not_active", "冻结记录状态不可操作");
  }

  return sendError(reply, 500, fallbackCode, "积分操作失败");
}
