import type { JsonValue } from "../../../../shared/outbox-inbox/receipt.js";
import { CommandReceiptRepository } from "../../../../shared/outbox-inbox/receipt.js";
import type { VerifiedRequestSecurityContext } from "../../../../shared/security-context/index.js";
import { PlatformUnitOfWork } from "../../../../shared/unit-of-work/unit-of-work.js";
import { authorizationDigest } from "../contracts/authorization-digest.js";
import type {
  ModelOptionCatalogReadPort,
  SessionAuthorizationRepository,
} from "../contracts/session-authorization-ports.js";
import {
  parsePublicProductContext,
  type PublicProductContext,
  type ProductContextSnapshot,
  type ProductWorkloadIdentity,
} from "../../domain/session-access-grant.js";

export interface ProductContextReceipt {
  readonly commandId: string;
  readonly committedAt: string;
  readonly receiptRef: string;
  readonly requestDigest: string;
  readonly state: "committed";
}

export class ExchangeProductContextService {
  constructor(
    private readonly unitOfWork: PlatformUnitOfWork,
    private readonly repository: SessionAuthorizationRepository,
    private readonly modelOptions: ModelOptionCatalogReadPort,
    private readonly receipts: CommandReceiptRepository = new CommandReceiptRepository(),
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async execute(input: Readonly<{
    workload: ProductWorkloadIdentity;
    context: VerifiedRequestSecurityContext;
    commandId: string;
    commandRef: string;
    idempotencyKey: string;
  }>): Promise<Readonly<{ receipt: ProductContextReceipt; context: PublicProductContext }>> {
    const requestDigest = authorizationDigest({
      contractVersion: "1",
      operation: "exchangeProductContext",
      workloadIdentityId: input.workload.workloadIdentityId,
      bindingRef: input.workload.siteProjectBindingRef,
      commandRef: input.commandRef,
    });
    return this.unitOfWork.execute(
      { context: input.context, operation: "exchangeProductContext" },
      async (transaction) => {
        const receiptIdentity = {
          commandId: input.commandId,
          environment: input.workload.environment,
          region: input.workload.region,
          callerIdentity: input.workload.workloadIdentityId,
          operation: "exchangeProductContext",
          idempotencyKey: input.idempotencyKey,
          requestDigest,
        } as const;
        const existing = await this.receipts.begin(transaction, receiptIdentity);
        if (existing.commandId !== input.commandId) throw new Error("COMMAND_IDENTITY_CONFLICT");
        if (existing.state === "succeeded" && existing.result !== null) {
          const context = existingProductContext(existing.result);
          return Object.freeze({
            context,
            receipt: committedReceipt(input.commandId, requestDigest, context.issuedAt),
          });
        }
        const nowDate = this.clock();
        const issuedAt = instant(nowDate);
        const expiresAt = instant(new Date(nowDate.getTime() + 300_000));
        const published = await this.modelOptions.readForProductContext(
          { siteId: input.workload.siteRef, siteReleaseRef: input.workload.siteReleaseRef },
          input.context,
          transaction,
        );
        const snapshot = await this.repository.resolveProductContext(transaction, {
          workload: input.workload,
          now: issuedAt,
          expiresAt,
          cacheMaxAgeSeconds: 60,
          modelOptionCatalogRef: published.modelOptionCatalogRef,
          modelOptionCatalogs: published.modelOptionCatalogs,
        });
        const context = publicContext(snapshot);
        const result = jsonValue(context);
        await this.receipts.recordOutcome(transaction, receiptIdentity, {
          state: "succeeded",
          result,
          resultDigest: authorizationDigest(result),
        });
        return Object.freeze({
          context,
          receipt: committedReceipt(input.commandId, requestDigest, issuedAt),
        });
      },
    );
  }
}

function committedReceipt(commandId: string, requestDigest: string, committedAt: string): ProductContextReceipt {
  return Object.freeze({ commandId, committedAt, receiptRef: `command:${commandId}`, requestDigest, state: "committed" });
}

function instant(value: Date): string {
  return new Date(Math.floor(value.getTime() / 1_000) * 1_000).toISOString();
}

function jsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function existingProductContext(value: JsonValue): PublicProductContext {
  return parsePublicProductContext(value);
}

function publicContext(snapshot: ProductContextSnapshot): PublicProductContext {
  const { snapshotDigest: _snapshotDigest, ...context } = snapshot;
  return Object.freeze(context);
}
