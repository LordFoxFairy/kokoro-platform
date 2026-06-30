import { z } from "zod";
import type { GrantPurchaseCredits, ReverseCredits } from "../domain/repository.js";

const ensureAccountResponseSchema = z.object({
  data: z.object({ id: z.string().min(1) }),
});

// WHY: 透传站点与请求 id，credit 端据 x-kokoro-site-id 把账户落到正确站点。
function forwardHeaders(siteId: string, requestId: string): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-kokoro-site-id": siteId,
    "x-kokoro-request-id": requestId,
  };
}

async function ensureAccountId(
  base: string,
  headers: Record<string, string>,
  ownerKind: "team",
  ownerId: string,
): Promise<string> {
  const ensureResponse = await fetch(`${base}/credit/accounts/ensure`, {
    method: "POST",
    headers,
    body: JSON.stringify({ ownerKind, ownerId }),
  });
  if (!ensureResponse.ok) {
    throw new Error(`credit ensure failed: ${ensureResponse.status}`);
  }
  return ensureAccountResponseSchema.parse(await ensureResponse.json()).data.id;
}

export function createCreditGrantClient(creditBaseUrl: string): GrantPurchaseCredits {
  const base = creditBaseUrl.replace(/\/+$/, "");

  return async (input) => {
    const headers = forwardHeaders(input.siteId, input.requestId);
    const accountId = await ensureAccountId(base, headers, input.ownerKind, input.ownerId);

    const grantResponse = await fetch(`${base}/credit/grant`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        accountId,
        amountMicros: input.amountMicros,
        idempotencyKey: input.idempotencyKey,
        reason: input.reason,
      }),
    });
    if (!grantResponse.ok) {
      throw new Error(`credit grant failed: ${grantResponse.status}`);
    }
  };
}

// WHY: 退款反向扣回积分；spend 余额不足在 credit 端返回非 2xx，抛错让管理员可见。
export function createCreditReverseClient(creditBaseUrl: string): ReverseCredits {
  const base = creditBaseUrl.replace(/\/+$/, "");

  return async (input) => {
    const headers = forwardHeaders(input.siteId, input.requestId);
    const accountId = await ensureAccountId(base, headers, input.ownerKind, input.ownerId);

    const spendResponse = await fetch(`${base}/credit/spend`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        accountId,
        amountMicros: input.amountMicros,
        idempotencyKey: input.idempotencyKey,
        reason: input.reason,
      }),
    });
    if (!spendResponse.ok) {
      throw new Error(`credit spend failed: ${spendResponse.status}`);
    }
  };
}
