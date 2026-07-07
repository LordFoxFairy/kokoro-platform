import type { FastifyInstance, FastifyRequest } from "fastify";
import { AppError } from "../domain/errors.js";
import { readRequestContext } from "./request-context.js";
import { isZodError, sendError, sendZodError } from "./responses.js";

// Fastify 把 setErrorHandler 的 error 给成 unknown；窄化出带 4xx statusCode 的客户端错误（body 解析/content-type 等）。
function asClientError(error: unknown): { statusCode: number; message: string } | null {
  if (
    typeof error === "object" &&
    error !== null &&
    "statusCode" in error &&
    typeof error.statusCode === "number" &&
    error.statusCode >= 400 &&
    error.statusCode < 500
  ) {
    const message =
      "message" in error && typeof error.message === "string" ? error.message : "请求无效";
    return { statusCode: error.statusCode, message };
  }
  return null;
}

// 全局错误 hook：Zod→400、AppError→其状态、Fastify 4xx→request.invalid、未知→500（不泄内部细节）。
export function registerErrorHandler(
  app: FastifyInstance,
  onUnknown?: (error: unknown, request: FastifyRequest) => void,
): void {
  app.setErrorHandler((error, request, reply) => {
    const { requestId } = readRequestContext(request.headers);
    if (isZodError(error)) {
      return sendZodError(reply, error, requestId);
    }
    if (error instanceof AppError) {
      return sendError(reply, error.httpStatus, error.code, error.message, error.details, requestId);
    }
    const client = asClientError(error);
    if (client) {
      return sendError(reply, client.statusCode, "request.invalid", client.message, undefined, requestId);
    }
    onUnknown?.(error, request);
    return sendError(reply, 500, "internal.error", "内部错误", undefined, requestId);
  });
}
