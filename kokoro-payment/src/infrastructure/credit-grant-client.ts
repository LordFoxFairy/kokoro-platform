import { ensureCreditAccountResponseSchema } from "@kokoro/credit";
import { callService, type RequestContext } from "@kokoro/platform-kit";
import { z } from "zod";
import type { GrantPurchaseCredits, ReverseCredits } from "../domain/repository.js";

const mutationResultSchema = z.unknown();

// system principal + 站点/请求 id 透传：credit 端据 x-kokoro-site-id 落到正确站点账户，requestId 贯通链路。
function creditContext(siteId: string, requestId: string): RequestContext {
  return { requestId, siteId, principal: { kind: "system" } };
}

// 空串=未配置：不带 internalSecret 头(对齐 credit 侧「未配置直通」语义)；配置后携带并被入站守门校验。
function secretOpt(internalSecret: string): { internalSecret: string } | Record<string, never> {
  return internalSecret ? { internalSecret } : {};
}

async function ensureAccountId(
  baseUrl: string,
  internalSecret: string,
  ctx: RequestContext,
  ownerKind: "team",
  ownerId: string,
): Promise<string> {
  // callService 已剥 { data } 信封；响应契约 import 自 @kokoro/credit，上游改形状此处 typecheck 红。
  const account = await callService(ctx, {
    baseUrl,
    method: "POST",
    path: "/credit/accounts/ensure",
    schema: ensureCreditAccountResponseSchema,
    body: { ownerKind, ownerId },
    caller: "payment",
    ...secretOpt(internalSecret),
  });
  return account.id;
}

// 归队 platform-kit callService：补齐 principal、内部密钥、错误信封映射(非 2xx→AppError)、requestId 贯通。
export function createCreditGrantClient(
  creditBaseUrl: string,
  internalSecret = "",
): GrantPurchaseCredits {
  return async (input) => {
    const ctx = creditContext(input.siteId, input.requestId);
    const accountId = await ensureAccountId(creditBaseUrl, internalSecret, ctx, input.ownerKind, input.ownerId);

    await callService(ctx, {
      baseUrl: creditBaseUrl,
      method: "POST",
      path: "/credit/grant",
      schema: mutationResultSchema,
      body: {
        accountId,
        amountMicros: input.amountMicros,
        idempotencyKey: input.idempotencyKey,
        reason: input.reason,
      },
      caller: "payment",
      ...secretOpt(internalSecret),
    });
  };
}

// 退款反向扣回积分；spend 余额不足在 credit 端返回非 2xx，callService 映射为 AppError 让管理员可见。
export function createCreditReverseClient(
  creditBaseUrl: string,
  internalSecret = "",
): ReverseCredits {
  return async (input) => {
    const ctx = creditContext(input.siteId, input.requestId);
    const accountId = await ensureAccountId(creditBaseUrl, internalSecret, ctx, input.ownerKind, input.ownerId);

    await callService(ctx, {
      baseUrl: creditBaseUrl,
      method: "POST",
      path: "/credit/spend",
      schema: mutationResultSchema,
      body: {
        accountId,
        amountMicros: input.amountMicros,
        idempotencyKey: input.idempotencyKey,
        reason: input.reason,
      },
      caller: "payment",
      ...secretOpt(internalSecret),
    });
  };
}
