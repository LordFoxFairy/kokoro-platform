import type { PreviewRedemptionResponse } from "../../../../interfaces/http/generated/platform-public/types.gen.js";
import { definePlatformPublicOperation } from "../../../../interfaces/http/platform-public-operation-registry.js";
import type { PreviewRedemptionService } from "../../application/services/preview-redemption.js";

export const COMMERCE_PUBLIC_OPERATION_IDS = Object.freeze([
  "previewRedemption",
] as const);

export function createCommercePublicOperations(preview: PreviewRedemptionService) {
  return Object.freeze([
    definePlatformPublicOperation({
      operationId: "previewRedemption",
      async execute(input): Promise<PreviewRedemptionResponse> {
        return preview.execute({
          context: input.context,
          commandId: input.headers["X-Kokoro-Command-Id"],
          idempotencyKey: input.headers["Idempotency-Key"],
          code: input.body.code,
        });
      },
    }),
  ]);
}
