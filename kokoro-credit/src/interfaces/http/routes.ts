import { registerHealthRoute, sendData, sendError, sendZodError } from "@kokoro/platform-kit";
import type { FastifyInstance, FastifyReply } from "fastify";
import { ZodError } from "zod";
import type { CreditService } from "../../application/credit-service.js";
import {
  CreditAccountNotFoundError,
  CreditCaptureExceedsHoldError,
  CreditHoldNotActiveError,
  CreditHoldNotFoundError,
  InsufficientCreditError,
} from "../../domain/errors.js";
import {
  captureCreditRequestSchema,
  creditMutationRequestSchema,
  ensureCreditAccountRequestSchema,
  holdCreditRequestSchema,
  releaseCreditRequestSchema,
} from "./schemas.js";

export function registerCreditRoutes(app: FastifyInstance, service: CreditService): void {
  registerHealthRoute(app, "credit");

  app.post("/credit/accounts/ensure", async (request, reply) => {
    try {
      const input = ensureCreditAccountRequestSchema.parse(request.body);
      const result = await service.ensureAccount(input);
      return sendData(reply, result);
    } catch (error) {
      return handleCreditError(error, reply, "credit.account_ensure_failed");
    }
  });

  app.post("/credit/grant", async (request, reply) => {
    try {
      const input = creditMutationRequestSchema.parse(request.body);
      const result = await service.grantCredits(input);
      return sendData(reply, result);
    } catch (error) {
      return handleCreditError(error, reply, "credit.grant_failed");
    }
  });

  app.post("/credit/spend", async (request, reply) => {
    try {
      const input = creditMutationRequestSchema.parse(request.body);
      const result = await service.spendCredits(input);
      return sendData(reply, result);
    } catch (error) {
      return handleCreditError(error, reply, "credit.spend_failed");
    }
  });

  app.post("/credit/hold", async (request, reply) => {
    try {
      const input = holdCreditRequestSchema.parse(request.body);
      const result = await service.holdCredits(input);
      return sendData(reply, result);
    } catch (error) {
      return handleCreditError(error, reply, "credit.hold_failed");
    }
  });

  app.post("/credit/capture", async (request, reply) => {
    try {
      const input = captureCreditRequestSchema.parse(request.body);
      const result = await service.captureHold(input);
      return sendData(reply, result);
    } catch (error) {
      return handleCreditError(error, reply, "credit.capture_failed");
    }
  });

  app.post("/credit/release", async (request, reply) => {
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

  if (error instanceof InsufficientCreditError) {
    return sendError(reply, 402, "credit.insufficient", "积分余额不足");
  }

  if (error instanceof CreditAccountNotFoundError) {
    return sendError(reply, 404, "credit.account_not_found", "积分账户不存在");
  }

  if (error instanceof CreditHoldNotFoundError) {
    return sendError(reply, 404, "credit.hold_not_found", "冻结记录不存在");
  }

  if (error instanceof CreditCaptureExceedsHoldError) {
    return sendError(reply, 400, "credit.capture_exceeds_hold", "结算金额超过冻结额度");
  }

  if (error instanceof CreditHoldNotActiveError) {
    return sendError(reply, 400, "credit.hold_not_active", "冻结记录状态不可操作");
  }

  return sendError(reply, 500, fallbackCode, "积分操作失败");
}
