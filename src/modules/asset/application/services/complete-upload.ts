import { randomUUID } from "node:crypto";
import type { JsonValue } from "../../../../shared/outbox-inbox/receipt.js";
import type { VerifiedRequestSecurityContext } from "../../../../shared/security-context/index.js";
import type { AssetUnitOfWorkPort } from "../contracts/asset-upload-ports.js";
import type {
  AssetCompletionOutboxPort,
  AssetCompletionReceiptPort,
  AssetUploadCompletionRepositoryPort,
} from "../contracts/asset-upload-completion-ports.js";
import { digestAssetCommand } from "../asset-digest.js";
import { resolveAssetUserAuthority } from "../asset-user-authority.js";

const OPERATION = "asset.complete-upload";

export interface CompleteUploadResult {
  readonly intentRef: string;
  readonly sessionRef: string;
  readonly state: "completing";
  readonly expectedVersion: bigint;
  readonly completionReceiptRef: string;
}

export class CompleteUploadService {
  constructor(private readonly dependencies: Readonly<{
    unitOfWork: AssetUnitOfWorkPort;
    repository: AssetUploadCompletionRepositoryPort;
    receipts: AssetCompletionReceiptPort;
    outbox: AssetCompletionOutboxPort;
    eventId?: () => string;
  }>) {}

  async execute(input: Readonly<{
    context: VerifiedRequestSecurityContext;
    commandId: string;
    idempotencyKey: string;
    intentRef: string;
    sessionRef: string;
    expectedVersion: bigint;
  }>): Promise<CompleteUploadResult> {
    const authority = resolveAssetUserAuthority(input.context, OPERATION);
    bounded(input.idempotencyKey, 8, 128, "ASSET_IDEMPOTENCY_KEY_INVALID");
    bounded(input.intentRef, 3, 128, "ASSET_UPLOAD_INTENT_REF_INVALID");
    bounded(input.sessionRef, 3, 128, "ASSET_UPLOAD_SESSION_REF_INVALID");
    if (input.expectedVersion < 1n) throw new Error("ASSET_UPLOAD_VERSION_INVALID");
    const requestDigest = digestAssetCommand({
      operation: OPERATION,
      ...authority,
      intentRef: input.intentRef,
      sessionRef: input.sessionRef,
      expectedVersion: input.expectedVersion,
    });
    const identity = Object.freeze({
      commandId: input.commandId,
      environment: input.context.environment,
      region: input.context.region,
      callerIdentity: `${authority.workloadIdentityId}:${authority.subjectRef}:${authority.subjectGeneration}`,
      operation: OPERATION,
      idempotencyKey: input.idempotencyKey,
      requestDigest,
    });
    return this.dependencies.unitOfWork.execute(
      { context: input.context, operation: OPERATION },
      async (transaction) => {
        const existing = await this.dependencies.receipts.begin(transaction, identity);
        if (existing.commandId !== input.commandId) throw new Error("ASSET_IDEMPOTENCY_DIGEST_CONFLICT");
        if (existing.state === "succeeded") return completionResult(existing.result);
        if (existing.state === "failed") throw new Error("ASSET_UPLOAD_COMPLETION_REJECTED");
        const session = await this.dependencies.repository.beginCompletion(transaction, {
          authority,
          intentRef: input.intentRef,
          sessionRef: input.sessionRef,
          expectedVersion: input.expectedVersion,
        });
        const eventId = (this.dependencies.eventId ?? randomUUID)();
        const payload = json({
          kind: "asset_upload_completion_requested_v1",
          siteRef: authority.siteRef,
          intentRef: session.intentRef,
          sessionRef: session.sessionRef,
          expectedVersion: session.expectedVersion.toString(),
        });
        await this.dependencies.outbox.enqueue(transaction, {
          eventId,
          owner: "asset",
          eventType: "asset.upload.completion.requested",
          aggregateId: session.sessionRef,
          payload,
          payloadDigest: digestAssetCommand(payload),
          correlationId: input.context.correlationId,
          causationId: input.commandId,
        });
        const result = json({
          intentRef: session.intentRef,
          sessionRef: session.sessionRef,
          state: "completing",
          expectedVersion: session.expectedVersion.toString(),
          completionReceiptRef: eventId,
        });
        await this.dependencies.receipts.recordOutcome(transaction, identity, {
          state: "succeeded",
          result,
          resultDigest: digestAssetCommand(result),
        });
        return completionResult(result);
      },
    );
  }
}

function completionResult(value: JsonValue | null): CompleteUploadResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("ASSET_COMPLETION_RECEIPT_INVALID");
  const result = value as Record<string, JsonValue>;
  if (
    typeof result.intentRef !== "string" || typeof result.sessionRef !== "string" ||
    result.state !== "completing" || typeof result.expectedVersion !== "string" ||
    !/^[1-9][0-9]*$/u.test(result.expectedVersion) || typeof result.completionReceiptRef !== "string"
  ) throw new Error("ASSET_COMPLETION_RECEIPT_INVALID");
  return Object.freeze({
    intentRef: result.intentRef,
    sessionRef: result.sessionRef,
    state: "completing",
    expectedVersion: BigInt(result.expectedVersion),
    completionReceiptRef: result.completionReceiptRef,
  });
}

function json(value: Readonly<Record<string, string>>): JsonValue {
  return Object.freeze({ ...value });
}

function bounded(value: string, minimum: number, maximum: number, code: string): void {
  if (value.length < minimum || value.length > maximum) throw new Error(code);
}
