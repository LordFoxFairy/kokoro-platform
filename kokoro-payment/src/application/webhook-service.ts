import type { IncomingHttpHeaders } from "node:http";
import { PaymentEventNotFoundError } from "../domain/errors.js";
import type { PaymentEvent } from "../domain/payment.js";
import type { PaymentProviderConfig } from "../domain/provider.js";
import type { ParsedWebhookEvent, PaymentWebhookProvider } from "../domain/webhook.js";
import { WebhookError } from "../domain/webhook.js";
import type { PaymentRepository, UpsertProviderInput } from "../domain/repository.js";
import type { WebhookProviderRegistry } from "../infrastructure/webhook/webhook-provider-registry.js";
import type { PaymentService } from "./payment-service.js";

// secretRef(env 变量名) → 密钥明文；默认实现读 process.env，测试可注入。
export type WebhookSecretResolver = (secretRef: string) => string | undefined;

export interface WebhookReceipt {
  event: PaymentEvent;
  // true=重复投递（事件已终态），本次未重新处理。
  duplicate: boolean;
}

export class PaymentWebhookService {
  constructor(
    private readonly repository: PaymentRepository,
    private readonly paymentService: PaymentService,
    private readonly providers: WebhookProviderRegistry,
    private readonly resolveSecret: WebhookSecretResolver,
  ) {}

  async upsertProvider(input: UpsertProviderInput): Promise<PaymentProviderConfig> {
    return this.repository.upsertProvider(input);
  }

  async deleteProvider(key: string): Promise<PaymentProviderConfig> {
    return this.repository.deleteProvider(key);
  }

  async listProviders(): Promise<PaymentProviderConfig[]> {
    return this.repository.listProviders();
  }

  async receiveWebhook(
    providerKey: string,
    headers: IncomingHttpHeaders,
    rawBody: Buffer,
    requestId: string,
  ): Promise<WebhookReceipt> {
    const config = await this.repository.findProviderByKey(providerKey);
    // 未配置与已停用同回 404：不向外部探测暴露配置差异。
    if (!config || !config.enabled) {
      throw new WebhookError(
        "payment.webhook_provider_unknown",
        `webhook provider is not accepting events: ${providerKey}`,
        404,
      );
    }
    const provider = this.requireProvider(config);
    const secret = this.resolveSecret(config.webhookSecretRef);
    if (!secret) {
      // fail-closed：密钥引用悬空时拒收，绝不跳过验签。
      throw new WebhookError(
        "payment.webhook_secret_unavailable",
        `webhook secret env is not set: ${config.webhookSecretRef}`,
        500,
      );
    }
    if (!provider.verifySignature(headers, rawBody, secret)) {
      throw new WebhookError("payment.webhook_signature_invalid", "webhook signature verification failed", 401);
    }

    let payload: unknown;
    try {
      payload = JSON.parse(rawBody.toString("utf8"));
    } catch {
      throw new WebhookError("payment.webhook_payload_invalid", "webhook body is not valid JSON", 400);
    }
    const parsed = provider.parseEvent(payload);

    // 重放防护：(provider,eventId) 唯一键幂等入库；已存在则拿回既有事件。
    const event = await this.repository.recordPaymentEvent({
      provider: config.key,
      eventId: parsed.eventId,
      eventType: parsed.eventType,
      payload,
    });
    if (event.status !== "received") {
      // 已终态(processed/failed)的重复投递：200 幂等应答，不重新处理；failed 走手动重放端点。
      return { event, duplicate: true };
    }
    return { event: await this.process(event, parsed, requestId), duplicate: false };
  }

  // 手动重放：failed(重试)或 received(处理中途崩溃的悬挂事件)重新走处理；processed 幂等返回。
  async replayEvent(id: string, requestId: string): Promise<PaymentEvent> {
    const event = await this.repository.findPaymentEventById(id);
    if (!event) {
      throw new PaymentEventNotFoundError(id);
    }
    if (event.status === "processed") {
      return event;
    }
    const config = await this.repository.findProviderByKey(event.provider);
    if (!config) {
      throw new WebhookError(
        "payment.webhook_provider_unknown",
        `webhook provider config missing for event replay: ${event.provider}`,
        404,
      );
    }
    // 重放走落库 payload，不再验签（入库时已验过原始字节）。
    const parsed = this.requireProvider(config).parseEvent(event.payload);
    return this.process(event, parsed, requestId);
  }

  private requireProvider(config: PaymentProviderConfig): PaymentWebhookProvider {
    const provider = this.providers.get(config.kind);
    if (!provider) {
      throw new WebhookError(
        "payment.webhook_provider_not_implemented",
        `webhook verification for provider kind is not implemented yet: ${config.kind}`,
        501,
      );
    }
    return provider;
  }

  // 状态机推进：received|failed → processed（成功）/ failed（失败留 lastError）。
  private async process(
    event: PaymentEvent,
    parsed: ParsedWebhookEvent,
    requestId: string,
  ): Promise<PaymentEvent> {
    try {
      if (parsed.eventType === "payment_succeeded") {
        if (!parsed.orderId) {
          throw new Error("payment_succeeded event is missing data.orderId");
        }
        // 复用既有幂等确认链：grant 幂等键=order:<id>，重复处理不会重复发积分。
        await this.paymentService.confirmOrder(parsed.orderId, requestId);
      }
      // 其余事件类型当前无订单联动：直接 ack 为 processed（与主流网关对未订阅事件的处理一致）。
      const processed = await this.repository.transitionPaymentEventStatus(
        event.id,
        ["received", "failed"],
        "processed",
        null,
      );
      return processed ?? (await this.repository.findPaymentEventById(event.id)) ?? event;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failed = await this.repository.transitionPaymentEventStatus(
        event.id,
        ["received", "failed"],
        "failed",
        message,
      );
      return failed ?? (await this.repository.findPaymentEventById(event.id)) ?? event;
    }
  }
}
