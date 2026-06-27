import type { FastifyInstance, FastifyReply } from "fastify";
import { ZodError } from "zod";

export interface ErrorEnvelope {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
  requestId?: string;
}

export function registerHealthRoute(app: FastifyInstance, moduleName: string): void {
  app.get("/healthz", async (_request, reply) =>
    sendData(reply, {
      module: moduleName,
      status: "ok",
    }),
  );
}

export function sendData<Data>(reply: FastifyReply, data: Data, statusCode = 200, requestId?: string) {
  return reply.code(statusCode).send(requestId ? { data, requestId } : { data });
}

export function sendError(
  reply: FastifyReply,
  statusCode: number,
  code: string,
  message: string,
  details?: unknown,
  requestId?: string,
) {
  const envelope: ErrorEnvelope = {
    error: {
      code,
      message,
    },
  };

  if (details !== undefined) {
    envelope.error.details = details;
  }

  if (requestId) {
    envelope.requestId = requestId;
  }

  return reply.code(statusCode).send(envelope);
}

export function sendZodError(reply: FastifyReply, error: ZodError, requestId?: string) {
  return sendError(reply, 400, "request.invalid", "请求参数无效", {
    issues: error.issues,
  }, requestId);
}

export function sendUnknownError(reply: FastifyReply, code: string, message: string) {
  return sendError(reply, 500, code, message);
}

export function isZodError(error: unknown): error is ZodError {
  return error instanceof ZodError;
}
