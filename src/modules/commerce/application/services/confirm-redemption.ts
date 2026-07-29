import { createHash } from "node:crypto";
import type { VerifiedRequestSecurityContext } from "../../../../shared/security-context/index.js";
import type { PlatformUnitOfWork } from "../../../../shared/unit-of-work/unit-of-work.js";
import type { JsonValue } from "../../../../shared/outbox-inbox/receipt.js";
import type { CommerceCommandFence } from "../command-fence.js";
import type {
  RedemptionConfirmationRepository,
  StoredRedemptionReceipt,
} from "../contracts/redemption-confirmation-repository.js";
import type { RedemptionSecretPort } from "../contracts/redemption-secret-port.js";
import { createCommerceCommandIdentity } from "../../domain/command-identity.js";
import { commerceCanonicalJson } from "../../domain/canonical-json.js";
import { CommerceApplicationError } from "../commerce-application-error.js";

export type ConfirmRedemptionView =
  | Readonly<{
    kind: "succeeded";
    command: RedemptionCommandCursor;
    redemption: Omit<StoredRedemptionReceipt, "commandReceivedAt" | "commandUpdatedAt">;
  }>
  | Readonly<{
    kind: "rejected";
    command: RedemptionCommandCursor;
    rejection: Readonly<{
      code: "REDEEM_NOT_ACCEPTED" | "REDEEM_TEMPORARILY_UNAVAILABLE";
      retryClass: "never" | "after_delay" | "after_user_action";
      retryAfter: string | null;
    }>;
  }>
  | Readonly<{
    kind: "accepted" | "executing" | "outcome_unknown";
    command: RedemptionCommandCursor;
    retryAfter: string;
  }>;

type RedemptionCommandCursor = Readonly<{
  commandId: string;
  receiptRef: string;
  receivedAt: string;
  requestDigest: string;
  updatedAt: string;
}>;

export class ConfirmRedemptionService {
  readonly #clock: () => Date;

  constructor(private readonly dependencies: Readonly<{
    unitOfWork: Pick<PlatformUnitOfWork, "execute">;
    fence: Pick<CommerceCommandFence, "execute">;
    repository: RedemptionConfirmationRepository;
    secrets: RedemptionSecretPort;
    clock?: () => Date;
  }>) {
    this.#clock = dependencies.clock ?? (() => new Date());
  }

  async execute(input: Readonly<{
    context: VerifiedRequestSecurityContext;
    commandId: string;
    idempotencyKey: string;
    previewCredential: string;
    legalAcceptanceRefs: readonly string[];
  }>): Promise<ConfirmRedemptionView> {
    const siteId = input.context.target.siteId;
    if (input.context.actor.kind !== "user" || siteId === null) throw new Error("COMMERCE_EFFECT_NOT_AUTHORIZED");
    let requestDigest: string;
    try {
      requestDigest = this.dependencies.secrets.confirmRequestDigest({
        siteId,
        subjectId: input.context.actor.subjectId,
        subjectGeneration: input.context.actor.subjectGeneration,
        previewCredential: input.previewCredential,
        legalAcceptanceRefs: input.legalAcceptanceRefs,
      });
    } catch {
      throw new CommerceApplicationError("REDEEM_NOT_ACCEPTED");
    }
    const capability = this.dependencies.secrets.verifyPreviewCredential(input.previewCredential);
    if (capability === null) throw new CommerceApplicationError("REDEEM_NOT_ACCEPTED");
    const identity = createCommerceCommandIdentity({
      commandId: input.commandId,
      environment: input.context.environment,
      region: input.context.region,
      siteId,
      actorKind: "user",
      actorSubject: input.context.actor.subjectId,
      actorGeneration: input.context.actor.subjectGeneration,
      operation: "confirmRedemption",
      idempotencyKey: input.idempotencyKey,
      commandVersion: "redemption-confirm-v1",
      requestDigest,
    });
    await this.dependencies.fence.execute(
      { context: input.context, identity },
      async ({ transaction, authority, locks }) => {
        const observedAt = this.#clock().toISOString();
        const outcome = await this.dependencies.repository.confirmRedemption(transaction, {
          siteId,
          subjectId: identity.actorSubject,
          subjectGeneration: identity.actorGeneration,
          commandId: identity.commandId,
          previewRef: capability.previewRef,
          credentialKeyRevision: capability.keyRevision,
          credentialDigest: capability.credentialDigest,
          legalAcceptanceRefs: Object.freeze([...input.legalAcceptanceRefs]),
          authorityReleaseRef: authority.releaseRef,
          workloadIdentityId: input.context.trustedCaller.workloadIdentityId,
          confirmedAt: observedAt,
        }, locks);
        if (outcome.kind === "succeeded") {
          const result: JsonValue = Object.freeze({
            kind: "redemption_succeeded",
            redemptionId: outcome.receipt.redemptionId,
            fulfilledAt: outcome.receipt.redeemedAt,
          });
          return Object.freeze({ state: "succeeded" as const, result, resultDigest: digest(result) });
        }
        const result: JsonValue = Object.freeze({
          kind: "redemption_rejected",
          code: outcome.code,
          rejectedAt: observedAt,
        });
        return Object.freeze({ state: "failed" as const, result, resultDigest: digest(result) });
      },
    );
    const stored = await this.dependencies.unitOfWork.execute(
      { context: input.context, operation: "confirmRedemption" },
      (transaction) => this.dependencies.repository.findConfirmationByCommand(transaction, {
        siteId,
        subjectId: identity.actorSubject,
        subjectGeneration: identity.actorGeneration,
        commandId: identity.commandId,
      }),
    );
    if (stored === null) throw new CommerceApplicationError("REDEEM_TEMPORARILY_UNAVAILABLE");
    if (stored.state === "succeeded") return succeededView(stored.receipt, requestDigest);
    if (stored.state === "failed") {
      return rejectedView(
        identity.commandId,
        requestDigest,
        stored.commandReceivedAt,
        stored.commandUpdatedAt,
        stored.code,
      );
    }
    return Object.freeze({
      kind: stored.state === "outcome_unknown" ? "outcome_unknown" as const : "executing" as const,
      command: cursor(identity.commandId, requestDigest, stored.commandReceivedAt, stored.commandUpdatedAt),
      retryAfter: new Date(Date.parse(stored.commandUpdatedAt) + 2_000).toISOString(),
    });
  }
}

function succeededView(receipt: StoredRedemptionReceipt, requestDigest: string): ConfirmRedemptionView {
  const { commandReceivedAt, commandUpdatedAt, ...redemption } = receipt;
  return Object.freeze({
    kind: "succeeded" as const,
    command: cursor(receipt.commandId, requestDigest, commandReceivedAt, commandUpdatedAt),
    redemption: Object.freeze(redemption),
  });
}

function rejectedView(
  commandId: string,
  requestDigest: string,
  receivedAt: string,
  updatedAt: string,
  code: "REDEEM_NOT_ACCEPTED" | "REDEEM_TEMPORARILY_UNAVAILABLE",
): ConfirmRedemptionView {
  return Object.freeze({
    kind: "rejected" as const,
    command: cursor(commandId, requestDigest, receivedAt, updatedAt),
    rejection: Object.freeze({
      code,
      retryClass: code === "REDEEM_NOT_ACCEPTED" ? "never" as const : "after_delay" as const,
      retryAfter: null,
    }),
  });
}

function cursor(commandId: string, requestDigest: string, receivedAt: string, updatedAt: string): RedemptionCommandCursor {
  return Object.freeze({ commandId, receiptRef: `commerce-command:${commandId}`, receivedAt, requestDigest, updatedAt });
}

function digest(value: JsonValue): string {
  return createHash("sha256").update(commerceCanonicalJson(value), "utf8").digest("hex");
}
