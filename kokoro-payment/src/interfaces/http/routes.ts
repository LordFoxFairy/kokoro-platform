import { registerHealthRoute, sendData, sendError, sendZodError } from "@kokoro/platform-kit";
import type { FastifyInstance, FastifyReply } from "fastify";
import { ZodError } from "zod";
import type { PaymentService } from "../../application/payment-service.js";
import {
  OrderNotConfirmableError,
  OrderNotFoundError,
  PaymentIdempotencyConflictError,
  PlanNotFoundError,
} from "../../domain/errors.js";
import {
  confirmOrderParamsSchema,
  createOrderRequestSchema,
  recordPaymentEventRequestSchema,
  upsertPlanRequestSchema,
} from "./schemas.js";

export function registerPaymentRoutes(app: FastifyInstance, service: PaymentService): void {
  registerHealthRoute(app, "payment");

  app.post("/plans/upsert", async (request, reply) => {
    try {
      const input = upsertPlanRequestSchema.parse(request.body);
      const result = await service.upsertPlan(input);
      return sendData(reply, result);
    } catch (error) {
      return handlePaymentError(error, reply, "payment.plan_upsert_failed");
    }
  });

  app.post("/orders", async (request, reply) => {
    try {
      const input = createOrderRequestSchema.parse(request.body);
      const result = await service.createOrder(input);
      return sendData(reply, result);
    } catch (error) {
      return handlePaymentError(error, reply, "payment.order_create_failed");
    }
  });

  app.post("/orders/:id/confirm", async (request, reply) => {
    try {
      const { id } = confirmOrderParamsSchema.parse(request.params);
      const result = await service.confirmOrder(id);
      return sendData(reply, result);
    } catch (error) {
      return handlePaymentError(error, reply, "payment.order_confirm_failed");
    }
  });

  app.post("/payment-events/record", async (request, reply) => {
    try {
      const input = recordPaymentEventRequestSchema.parse(request.body);
      const result = await service.recordPaymentEvent(input);
      return sendData(reply, result);
    } catch (error) {
      return handlePaymentError(error, reply, "payment.event_record_failed");
    }
  });
}

function handlePaymentError(error: unknown, reply: FastifyReply, fallbackCode: string) {
  if (error instanceof ZodError) {
    return sendZodError(reply, error);
  }

  if (error instanceof PaymentIdempotencyConflictError) {
    return sendError(reply, 409, "payment.idempotency_conflict", "幂等键已被不同请求使用");
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

  return sendError(reply, 500, fallbackCode, "支付操作失败");
}
