import {
  jsonSchema,
  readRequestContext,
  registerHealthRoute,
  registerMetricsRoute,
  sendData,
  sendError,
  sendZodError,
} from "@kokoro/platform-kit";
import type { FastifyInstance, FastifyReply } from "fastify";
import { ZodError } from "zod";
import type { PaymentService } from "../../application/payment-service.js";
import {
  CheckoutUnavailableError,
  OrderAmountMismatchError,
  OrderNotConfirmableError,
  OrderNotFoundError,
  OrderNotRefundableError,
  PaymentEventNotFoundError,
  PaymentIdempotencyConflictError,
  PaymentProviderNotFoundError,
  PlanNotFoundError,
} from "../../domain/errors.js";
import { isPaymentLifecycleError } from "../../domain/payment-lifecycle.js";
import { isWebhookError } from "../../domain/webhook.js";
import {
  checkoutRequestSchema,
  confirmOrderParamsSchema,
  createOrderRequestSchema,
  deleteRequestSchema,
  planParamsSchema,
  recordPaymentEventRequestSchema,
  refundOrderParamsSchema,
  upsertPlanRequestSchema,
} from "./schemas.js";

export function registerPaymentRoutes(app: FastifyInstance, service: PaymentService): void {
  registerHealthRoute(app, "payment");
  registerMetricsRoute(app, "payment");

  app.post("/plans/upsert", {
    schema: {
      tags: ["payment"],
      summary: "创建或更新套餐",
      body: jsonSchema(upsertPlanRequestSchema),
    },
  }, async (request, reply) => {
    try {
      const ctx = readRequestContext(request.headers);
      if (ctx.siteId === null) {
        return sendError(reply, 400, "payment.site_required", "缺少站点上下文", undefined, ctx.requestId);
      }
      const body = upsertPlanRequestSchema.parse(request.body);
      const result = await service.upsertPlan({ ...body, siteId: ctx.siteId });
      return sendData(reply, result);
    } catch (error) {
      return handlePaymentError(error, reply, "payment.plan_upsert_failed");
    }
  });

  app.delete("/plans/:planId", {
    schema: {
      tags: ["payment"],
      summary: "删除套餐",
      params: jsonSchema(planParamsSchema),
      body: jsonSchema(deleteRequestSchema),
    },
  }, async (request, reply) => {
    try {
      const { planId } = planParamsSchema.parse(request.params);
      const input = deleteRequestSchema.parse(request.body);
      const result = await service.deletePlan({ id: planId, deletedBy: input.deletedBy, reason: input.reason });
      return sendData(reply, result);
    } catch (error) {
      return handlePaymentError(error, reply, "payment.plan_delete_failed");
    }
  });

  app.post("/plans/:planId/restore", {
    schema: {
      tags: ["payment"],
      summary: "恢复套餐",
      params: jsonSchema(planParamsSchema),
    },
  }, async (request, reply) => {
    try {
      const { planId } = planParamsSchema.parse(request.params);
      const result = await service.restorePlan({ id: planId });
      return sendData(reply, result);
    } catch (error) {
      return handlePaymentError(error, reply, "payment.plan_restore_failed");
    }
  });

  app.get("/plans", {
    schema: {
      tags: ["payment"],
      summary: "在售套餐目录（storefront 读面）",
    },
  }, async (request, reply) => {
    try {
      const ctx = readRequestContext(request.headers);
      if (ctx.siteId === null) {
        return sendError(reply, 400, "payment.site_required", "缺少站点上下文", undefined, ctx.requestId);
      }
      const plans = await service.listSellablePlans(ctx.siteId);
      // 只投当店面所需字段；内部审计/软删字段（deletedBy 等）不外泄到 web。
      const catalog = plans.map((plan) => ({
        id: plan.id,
        key: plan.key,
        name: plan.name,
        currency: plan.currency,
        amountMinor: plan.amountMinor,
        creditMicros: plan.creditMicros,
        billingInterval: plan.billingInterval,
      }));
      return sendData(reply, { plans: catalog }, 200, ctx.requestId);
    } catch (error) {
      return handlePaymentError(error, reply, "payment.plan_list_failed");
    }
  });

  app.post("/orders/checkout", {
    schema: {
      tags: ["payment"],
      summary: "创建收银台会话（V1 未接入托管收银台 → 501）",
      body: jsonSchema(checkoutRequestSchema),
    },
  }, async (request, reply) => {
    try {
      const ctx = readRequestContext(request.headers);
      if (ctx.siteId === null) {
        return sendError(reply, 400, "payment.site_required", "缺少站点上下文", undefined, ctx.requestId);
      }
      const body = checkoutRequestSchema.parse(request.body);
      // 有可用收银台 provider（dev=mock）→ 建单 + 返回 checkoutUrl；无 → startCheckout 抛
      // CheckoutUnavailableError，handlePaymentError 归一成 501（web 渲染「支付暂未开通」）。
      const result = await service.startCheckout({ ...body, siteId: ctx.siteId });
      return sendData(reply, { checkoutUrl: result.checkoutUrl }, 200, ctx.requestId);
    } catch (error) {
      return handlePaymentError(error, reply, "payment.checkout_failed");
    }
  });

  app.post("/orders", {
    schema: {
      tags: ["payment"],
      summary: "创建订单",
      body: jsonSchema(createOrderRequestSchema),
    },
  }, async (request, reply) => {
    try {
      const ctx = readRequestContext(request.headers);
      if (ctx.siteId === null) {
        return sendError(reply, 400, "payment.site_required", "缺少站点上下文", undefined, ctx.requestId);
      }
      const body = createOrderRequestSchema.parse(request.body);
      const result = await service.createOrder({ ...body, siteId: ctx.siteId });
      return sendData(reply, result);
    } catch (error) {
      return handlePaymentError(error, reply, "payment.order_create_failed");
    }
  });

  app.post("/orders/sweep", {
    schema: {
      tags: ["payment"],
      summary: "收尾悬挂的 confirming 订单（确认中途崩溃的重放,幂等）",
    },
  }, async (request, reply) => {
    try {
      const ctx = readRequestContext(request.headers);
      const recovered = await service.sweepStaleConfirmingOrders(120_000, ctx.requestId);
      return sendData(reply, { recovered }, 200, ctx.requestId);
    } catch (error) {
      return handlePaymentError(error, reply, "payment.confirm_sweep_failed");
    }
  });

  app.post("/orders/:id/confirm", {
    schema: {
      tags: ["payment"],
      summary: "确认订单（发放积分并标记已付）",
      params: jsonSchema(confirmOrderParamsSchema),
    },
  }, async (request, reply) => {
    try {
      const ctx = readRequestContext(request.headers);
      const { id } = confirmOrderParamsSchema.parse(request.params);
      const result = await service.confirmOrder(id, ctx.requestId);
      return sendData(reply, result);
    } catch (error) {
      return handlePaymentError(error, reply, "payment.order_confirm_failed");
    }
  });

  app.post("/orders/:id/refund", {
    schema: {
      tags: ["payment"],
      summary: "退款订单（回滚积分）",
      params: jsonSchema(refundOrderParamsSchema),
    },
  }, async (request, reply) => {
    try {
      const ctx = readRequestContext(request.headers);
      const { id } = refundOrderParamsSchema.parse(request.params);
      const result = await service.refundOrder(id, ctx.requestId);
      return sendData(reply, result);
    } catch (error) {
      return handlePaymentError(error, reply, "payment.order_refund_failed");
    }
  });

  app.post("/payment-events/record", {
    schema: {
      tags: ["payment"],
      summary: "记录支付事件（webhook 幂等入库）",
      body: jsonSchema(recordPaymentEventRequestSchema),
    },
  }, async (request, reply) => {
    try {
      const input = recordPaymentEventRequestSchema.parse(request.body);
      const result = await service.recordPaymentEvent(input);
      return sendData(reply, result);
    } catch (error) {
      return handlePaymentError(error, reply, "payment.event_record_failed");
    }
  });
}

export function handlePaymentError(error: unknown, reply: FastifyReply, fallbackCode: string) {
  if (error instanceof ZodError) {
    return sendZodError(reply, error);
  }

  if (error instanceof PaymentIdempotencyConflictError) {
    return sendError(reply, 409, "payment.idempotency_conflict", "幂等键已被不同请求使用");
  }

  if (isPaymentLifecycleError(error)) {
    return sendError(reply, error.statusCode, error.code, error.message);
  }

  if (isWebhookError(error)) {
    return sendError(reply, error.statusCode, error.code, error.message);
  }

  if (error instanceof PaymentProviderNotFoundError) {
    return sendError(reply, 404, "payment.provider_not_found", "支付 provider 配置不存在");
  }

  if (error instanceof PaymentEventNotFoundError) {
    return sendError(reply, 404, "payment.event_not_found", "支付事件不存在");
  }

  if (error instanceof OrderNotFoundError) {
    return sendError(reply, 404, "payment.order_not_found", "订单不存在");
  }

  if (error instanceof PlanNotFoundError) {
    return sendError(reply, 404, "payment.plan_not_found", "套餐不存在");
  }

  if (error instanceof OrderNotConfirmableError) {
    return sendError(reply, 409, "payment.order_not_confirmable", "订单当前状态不可确认");
  }

  if (error instanceof OrderNotRefundableError) {
    return sendError(reply, 409, "payment.order_not_refundable", "订单当前状态不可退款");
  }

  if (error instanceof OrderAmountMismatchError) {
    return sendError(reply, 409, "payment.order_amount_mismatch", "订单金额与套餐定价不匹配");
  }

  if (error instanceof CheckoutUnavailableError) {
    // 501 未实现：本站未接入托管收银台 provider（诚实态，web 据此禁用购买按钮）。
    return sendError(reply, 501, "payment.checkout_unavailable", "支付渠道未配置");
  }

  return sendError(reply, 500, fallbackCode, "支付操作失败");
}
