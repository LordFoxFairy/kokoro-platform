import { readRequestContext, sendError } from "@kokoro/platform-kit";
import type { FastifyInstance } from "fastify";
import { ACQUISITION_CHANNEL_DISABLED } from "./routes.js";

// Provider ingress remains a stable fail-closed endpoint so already-configured providers
// receive an explicit retry-safe denial. No raw-body parser, verifier, SDK or secret resolver
// is assembled while redeem-only acquisition is in force.
export function registerPaymentWebhookRoutes(app: FastifyInstance): void {
  // Accept any provider content type only to reach the denial handler. The bounded Fastify
  // body reader discards the value; no provider-specific decoder or verifier is initialized.
  app.addContentTypeParser("*", { parseAs: "string" }, (_request, _body, done) => {
    done(null, undefined);
  });
  app.post("/payments/webhooks/:provider", async (request, reply) => {
    const { requestId } = readRequestContext(request.headers);
    return sendError(
      reply,
      503,
      ACQUISITION_CHANNEL_DISABLED,
      "支付购买通道未开放，请使用卡密兑换",
      undefined,
      requestId,
    );
  });
}
