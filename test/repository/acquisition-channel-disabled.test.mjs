import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { URL } from "node:url";

const layers = [
  {
    id: "runtime-router",
    files: ["kokoro-payment/src/interfaces/http/routes.ts"],
    forbidden: /service\.(?:startCheckout|createOrder|confirmOrder|refundOrder|recordPaymentEvent|sweepStaleConfirmingOrders)\s*\(/u,
    fixture: "service.confirmOrder(orderId, requestId);",
  },
  {
    id: "webhook-router",
    files: ["kokoro-payment/src/interfaces/http/webhook-routes.ts"],
    forbidden: /(?:PaymentWebhookService|receiveWebhook)\b/u,
    fixture: "webhookService.receiveWebhook(provider, headers, body, requestId);",
  },
  {
    id: "admin-surface",
    files: [
      "kokoro-payment/src/interfaces/admin/payment-admin-contract.ts",
      "kokoro-payment/src/interfaces/http/admin-routes.ts",
    ],
    forbidden: /(?:grantPlanToTeam|refundOrder|upsertProvider|deleteProvider|replayEvent)\s*\(/u,
    fixture: "await webhookService.upsertProvider(input);",
  },
  {
    id: "server-assembly",
    files: ["kokoro-payment/src/interfaces/http/server.ts"],
    forbidden: /(?:PaymentService|PaymentWebhookService|createWebhookProviderRegistry|setInterval|grantPurchaseCredits|reverseCredits|webhookSecretResolver|enabledProviderKinds)\b/u,
    fixture: "const worker = setInterval(runAcquisition, 1000);",
  },
  {
    id: "process-bootstrap",
    files: [
      "kokoro-payment/src/interfaces/http/main.ts",
      "kokoro-payment/src/index.ts",
      "kokoro-payment/src/module.ts",
    ],
    forbidden: /(?:createCreditGrantClient|createCreditReverseClient|parseEnabledProviders|KOKORO_PAYMENT_ENABLED_PROVIDERS|application\/(?:payment|webhook)-service|POST \/(?:plans\/upsert|orders(?:\/[^"\n]*)?|payment-events\/record|payments\/webhooks)|dependencies:\s*\[[^\]]*"credit")\b/u,
    fixture: "createCreditGrantClient(env.KOKORO_CREDIT_BASE_URL);",
  },
  {
    id: "environment",
    files: ["kokoro-payment/src/config/env.ts"],
    forbidden: /KOKORO_PAYMENT_(?:ENABLED_PROVIDERS|CONFIRM_SWEEP_INTERVAL_SECONDS|CONFIRM_STALE_SECONDS)\b/u,
    fixture: "KOKORO_PAYMENT_ENABLED_PROVIDERS: z.string().default(''),",
  },
  {
    id: "catalog-seed",
    files: ["kokoro-payment/src/interfaces/cli/seed-packs.ts"],
    forbidden: /(?:upsertProvider|KOKORO_PAYMENT_MOCK_WEBHOOK_SECRET|enabled:\s*true)\b/u,
    fixture: "await repo.upsertProvider({ key: 'mock', enabled: true });",
  },
];

async function sourceFor(layer) {
  const sources = await Promise.all(layer.files.map((file) => readFile(new URL(`../../${file}`, import.meta.url), "utf8")));
  return sources.join("\n");
}

function violations(layer, source) {
  return layer.forbidden.test(source) ? [layer.id] : [];
}

test("all seven acquisition layers are structurally fail-closed", async () => {
  assert.equal(layers.length, 7);
  for (const layer of layers) {
    assert.deepEqual(violations(layer, await sourceFor(layer)), [], layer.id);
  }
});

test("every acquisition detector bears weight against a violating fixture", async () => {
  for (const layer of layers) {
    const source = await sourceFor(layer);
    assert.deepEqual(violations(layer, `${source}\n${layer.fixture}`), [layer.id], layer.id);
  }
});
