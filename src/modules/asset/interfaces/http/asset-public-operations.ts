import type {
  AssetUploadCommandResponse,
  AssetUploadIntentResponse,
  AssetUploadStatusResponse,
  TrustedAssetGrantResponse,
} from "../../../../generated/contracts/openapi/platform-public/types.gen.js";
import { definePlatformPublicOperation } from "../../../../interfaces/http/platform-public-operation-registry.js";
import type { CreateUploadIntentService } from "../../application/services/create-upload-intent.js";
import type { CompleteUploadService } from "../../application/services/complete-upload.js";
import type { AssetOwnerQueryService } from "../../application/services/asset-owner-query.js";
import { assetPublicResult } from "../../application/asset-application-error.js";

export const ASSET_PUBLIC_OPERATION_IDS = Object.freeze([
  "createAssetUploadIntent",
  "completeAssetUpload",
  "getAssetUploadStatus",
  "recoverAssetUploadCommand",
  "getTrustedAssetGrant",
] as const);

export function createAssetPublicOperations(dependencies: Readonly<{
  create: Pick<CreateUploadIntentService, "execute">;
  complete: Pick<CompleteUploadService, "execute">;
  queries: Pick<AssetOwnerQueryService, "getUploadStatus" | "readCommand" | "getTrustedGrant">;
}>) {
  return Object.freeze([
    definePlatformPublicOperation({
      operationId: "createAssetUploadIntent",
      targetProjectRef: ({ path }) => path.projectRef,
      async execute(input): Promise<AssetUploadIntentResponse> {
        return assetPublicResult(async () => {
          const created = await dependencies.create.execute({
          context: input.context,
          commandId: input.headers["X-Kokoro-Command-Id"],
          idempotencyKey: input.headers["Idempotency-Key"],
          purpose: input.body.purpose,
          filename: input.body.filename,
          clientMediaType: input.body.clientMediaType,
          expectedSize: BigInt(input.body.expectedSize),
          expectedChecksumSha256: input.body.expectedChecksumSha256,
        });
          const command = await dependencies.queries.readCommand({
          context: input.context,
          commandId: created.commandId,
          requestOperation: "createAssetUploadIntent",
        });
          if (command.upload === null) throw new Error("ASSET_TEMPORARILY_UNAVAILABLE");
          return Object.freeze({
          receipt: command.receipt,
          upload: command.upload,
          capability: Object.freeze({
            protocolRevision: created.capability.protocolRevision,
            uploadEndpoint: created.capability.uploadEndpoint,
            credential: created.capability.credential,
            capabilityEpoch: created.capability.capabilityEpoch.toString(),
            expiresAt: created.capability.expiresAt,
            minimumPartBytes: created.capability.minimumPartBytes.toString(),
            maximumPartBytes: created.capability.maximumPartBytes.toString(),
          }),
          });
        });
      },
    }),
    definePlatformPublicOperation({
      operationId: "completeAssetUpload",
      targetProjectRef: ({ path }) => path.projectRef,
      async execute(input): Promise<AssetUploadCommandResponse> {
        return assetPublicResult(async () => {
          await dependencies.complete.execute({
          context: input.context,
          commandId: input.headers["X-Kokoro-Command-Id"],
          idempotencyKey: input.headers["Idempotency-Key"],
          intentRef: input.path.intentRef,
          sessionRef: input.body.sessionRef,
          expectedVersion: BigInt(input.body.expectedVersion),
        });
          return dependencies.queries.readCommand({
          context: input.context,
          commandId: input.headers["X-Kokoro-Command-Id"],
          requestOperation: "completeAssetUpload",
          });
        });
      },
    }),
    definePlatformPublicOperation({
      operationId: "getAssetUploadStatus",
      targetProjectRef: ({ path }) => path.projectRef,
      async execute(input): Promise<AssetUploadStatusResponse> {
        return assetPublicResult(async () => Object.freeze({
          upload: await dependencies.queries.getUploadStatus({
            context: input.context,
            intentRef: input.path.intentRef,
          }),
        }));
      },
    }),
    definePlatformPublicOperation({
      operationId: "recoverAssetUploadCommand",
      targetProjectRef: ({ path }) => path.projectRef,
      execute: (input): Promise<AssetUploadCommandResponse> => assetPublicResult(() =>
        dependencies.queries.readCommand({
          context: input.context,
          commandId: input.path.commandId,
          requestOperation: "recoverAssetUploadCommand",
        })),
    }),
    definePlatformPublicOperation({
      operationId: "getTrustedAssetGrant",
      targetProjectRef: ({ path }) => path.projectRef,
      async execute(input): Promise<TrustedAssetGrantResponse> {
        return assetPublicResult(async () => Object.freeze({
          grant: await dependencies.queries.getTrustedGrant({
            context: input.context,
            assetRef: input.path.assetRef,
            assetVersionRef: input.path.assetVersionRef,
            assetGrantRef: input.path.assetGrantRef,
            purpose: input.query.purpose,
            eligibilityEpoch: BigInt(input.query.eligibilityEpoch),
          }),
        }));
      },
    }),
  ]);
}
