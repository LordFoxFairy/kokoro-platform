import type {
  ConfirmRedemptionResponse,
  PreviewRedemptionResponse,
} from "../../../../interfaces/http/generated/platform-public/types.gen.js";
import { definePlatformPublicOperation } from "../../../../interfaces/http/platform-public-operation-registry.js";
import type { PreviewRedemptionService } from "../../application/services/preview-redemption.js";
import type { ConfirmRedemptionService } from "../../application/services/confirm-redemption.js";

export const COMMERCE_PUBLIC_OPERATION_IDS = Object.freeze([
  "previewRedemption",
  "confirmRedemption",
] as const);

export function createCommercePublicOperations(dependencies: Readonly<{
  preview: Pick<PreviewRedemptionService, "execute">;
  confirm: Pick<ConfirmRedemptionService, "execute">;
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
  ]);
}
