import { z } from "zod";
import type { GrantPurchaseCredits } from "../domain/repository.js";

const ensureAccountResponseSchema = z.object({
  data: z.object({ id: z.string().min(1) }),
});

export function createCreditGrantClient(creditBaseUrl: string): GrantPurchaseCredits {
  const base = creditBaseUrl.replace(/\/+$/, "");

  return async (input) => {
    const ensureResponse = await fetch(`${base}/credit/accounts/ensure`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ownerKind: input.ownerKind, ownerId: input.ownerId }),
    });
    if (!ensureResponse.ok) {
      throw new Error(`credit ensure failed: ${ensureResponse.status}`);
    }
    const accountId = ensureAccountResponseSchema.parse(await ensureResponse.json()).data.id;

    const grantResponse = await fetch(`${base}/credit/grant`, {
      method: "POST",
      headers: { "content-type": "application/json" },
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
