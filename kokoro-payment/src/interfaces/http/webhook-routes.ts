import { jsonSchema, readRequestContext, sendData } from "@kokoro/platform-kit";
import type { FastifyInstance } from "fastify";
import type { PaymentWebhookService } from "../../application/webhook-service.js";
import { handlePaymentError } from "./routes.js";
import { webhookProviderParamsSchema } from "./schemas.js";

// 必须注册在独立 encapsulation context：本域把 body 保留为原始字节（Buffer），
// 验签要覆盖 provider 发出的原始报文，不允许 JSON 预解析后再序列化验签。
export function registerPaymentWebhookRoutes(
  app: FastifyInstance,
  webhookService: PaymentWebhookService,
): void {
  app.removeAllContentTypeParsers();
  app.addContentTypeParser("*", { parseAs: "buffer" }, (_request, body, done) => {
    done(null, body);
  });

  app.post("/payments/webhooks/:provider", {
    schema: {
      tags: ["payment"],
      summary: "接收 provider webhook（验签 + 幂等入库 + 状态机推进）",
      params: jsonSchema(webhookProviderParamsSchema),
    },
  }, async (request, reply) => {
    try {
      const ctx = readRequestContext(request.headers);
      const { provider } = webhookProviderParamsSchema.parse(request.params);
      const rawBody = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
      const receipt = await webhookService.receiveWebhook(provider, request.headers, rawBody, ctx.requestId);
      return sendData(reply, receipt, 200, ctx.requestId);
    } catch (error) {
      return handlePaymentError(error, reply, "payment.webhook_failed");
    }
  });
}
