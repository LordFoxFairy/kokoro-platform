import type {
  ConfirmRedemptionResponse,
  GetRedemptionReceiptResponse,
  PreviewRedemptionResponse,
  RecoverRedemptionCommandResponse,
} from "../../../../interfaces/http/generated/platform-public/types.gen.js";
import { definePlatformPublicOperation } from "../../../../interfaces/http/platform-public-operation-registry.js";
import type { PreviewRedemptionService } from "../../application/services/preview-redemption.js";
import type { ConfirmRedemptionService } from "../../application/services/confirm-redemption.js";
import type { RedemptionQueryService } from "../../application/services/redemption-query.js";
import type { AccountReadService } from "../../application/services/account-read.js";

export const COMMERCE_PUBLIC_OPERATION_IDS = Object.freeze([
  "previewRedemption",
  "confirmRedemption",
  "recoverRedemptionCommand",
  "getRedemptionReceipt",
  "getCreditGrant",
  "getCreditSummary",
  "getUsageDetail",
  "listAccountProducts",
] as const);

export function createCommercePublicOperations(dependencies: Readonly<{
  preview: Pick<PreviewRedemptionService, "execute">;
  confirm: Pick<ConfirmRedemptionService, "execute">;
  queries: Pick<RedemptionQueryService, "recoverCommand" | "getReceipt">;
  accountQueries: Pick<AccountReadService, "getCreditGrant" | "getCreditSummary" | "getUsageDetail" | "listAccountProducts">;
}>) {
  return Object.freeze([
    definePlatformPublicOperation({
      operationId: "previewRedemption",
      async execute(input): Promise<PreviewRedemptionResponse> {
        return dependencies.preview.execute({
          context: input.context,
          commandId: input.headers["X-Kokoro-Command-Id"],
          idempotencyKey: input.headers["Idempotency-Key"],
          code: input.body.code,
        });
      },
    }),
    definePlatformPublicOperation({
      operationId: "confirmRedemption",
      successStatus(result) {
        if (typeof result !== "object" || result === null || !("kind" in result)) return 200;
        return result.kind === "accepted" || result.kind === "executing" || result.kind === "outcome_unknown"
          ? 202 : 200;
      },
      async execute(input): Promise<ConfirmRedemptionResponse> {
        const result = await dependencies.confirm.execute({
          context: input.context,
          commandId: input.headers["X-Kokoro-Command-Id"],
          idempotencyKey: input.headers["Idempotency-Key"],
          previewCredential: input.body.previewCredential,
          legalAcceptanceRefs: input.body.legalAcceptanceRefs,
        });
        if (result.kind !== "succeeded") return result;
        return {
          ...result,
          redemption: {
            ...result.redemption,
            outputs: result.redemption.outputs.map((output) => ({ ...output })),
            reversalRefs: [...result.redemption.reversalRefs],
          },
        };
      },
    }),
    definePlatformPublicOperation({
      operationId: "recoverRedemptionCommand",
      async execute(input): Promise<RecoverRedemptionCommandResponse> {
        const result = await dependencies.queries.recoverCommand({
          context: input.context,
          idempotencyKey: input.headers["Idempotency-Key"],
        });
        if (result.kind !== "succeeded") return result;
        return {
          ...result,
          redemption: {
            ...result.redemption,
            outputs: result.redemption.outputs.map((output) => ({ ...output })),
            reversalRefs: [...result.redemption.reversalRefs],
          },
        };
      },
    }),
    definePlatformPublicOperation({
      operationId: "getRedemptionReceipt",
      async execute(input): Promise<GetRedemptionReceiptResponse> {
        return dependencies.queries.getReceipt({
          context: input.context,
          redemptionId: input.path.id,
        });
      },
    }),
    definePlatformPublicOperation({
      operationId: "getCreditGrant",
      execute: (input) => dependencies.accountQueries.getCreditGrant({ context: input.context, grantId: input.path.id }),
    }),
    definePlatformPublicOperation({
      operationId: "getCreditSummary",
      execute: (input) => dependencies.accountQueries.getCreditSummary({ context: input.context }),
    }),
    definePlatformPublicOperation({
      operationId: "getUsageDetail",
      execute: (input) => dependencies.accountQueries.getUsageDetail({ context: input.context, usageId: input.path.id }),
    }),
    definePlatformPublicOperation({
      operationId: "listAccountProducts",
      execute: (input) => dependencies.accountQueries.listAccountProducts({ context: input.context }),
    }),
  ]);
}
