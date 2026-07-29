import type { VerifiedRequestSecurityContext } from "../../../../shared/security-context/index.js";
import type { PlatformUnitOfWork } from "../../../../shared/unit-of-work/unit-of-work.js";
import type { RedemptionReceiptResponse } from
  "../../../../interfaces/http/generated/platform-public/types.gen.js";
import type { RedemptionConfirmationRepository } from "../contracts/redemption-confirmation-repository.js";
import { CommerceApplicationError } from "../commerce-application-error.js";
import { redemptionCommandView, type ConfirmRedemptionView } from "./confirm-redemption.js";

export class RedemptionQueryService {
  constructor(private readonly dependencies: Readonly<{
    unitOfWork: Pick<PlatformUnitOfWork, "execute">;
    repository: RedemptionConfirmationRepository;
  }>) {}

  async recoverCommand(input: Readonly<{
    context: VerifiedRequestSecurityContext;
    idempotencyKey: string;
  }>): Promise<ConfirmRedemptionView> {
    const identity = userIdentity(input.context);
    const recovered = await this.dependencies.unitOfWork.execute(
      { context: input.context, operation: "recoverRedemptionCommand" },
      (transaction) => this.dependencies.repository.findConfirmationByIdempotencyKey(transaction, {
        ...identity,
        idempotencyKey: input.idempotencyKey,
      }),
    );
    if (recovered === null) throw new CommerceApplicationError("REDEMPTION_NOT_FOUND");
    return redemptionCommandView(recovered.confirmation, recovered.requestDigest, recovered.commandId);
  }

  async getReceipt(input: Readonly<{
    context: VerifiedRequestSecurityContext;
    redemptionId: string;
  }>): Promise<RedemptionReceiptResponse> {
    const identity = userIdentity(input.context);
    const receipt = await this.dependencies.unitOfWork.execute(
      { context: input.context, operation: "getRedemptionReceipt" },
      (transaction) => this.dependencies.repository.findRedemptionReceipt(transaction, {
        ...identity,
        redemptionId: input.redemptionId,
      }),
    );
    if (receipt === null) throw new CommerceApplicationError("REDEMPTION_NOT_FOUND");
    return Object.freeze({
      redemption: Object.freeze({
        ...receipt,
        outputs: receipt.outputs.map((output) => ({ ...output })),
        reversalRefs: [...receipt.reversalRefs],
      }),
    });
  }
}

function userIdentity(context: VerifiedRequestSecurityContext): Readonly<{
  siteId: string;
  subjectId: string;
  subjectGeneration: string;
}> {
  if (context.actor.kind !== "user" || context.target.siteId === null) {
    throw new Error("COMMERCE_EFFECT_NOT_AUTHORIZED");
  }
  return Object.freeze({
    siteId: context.target.siteId,
    subjectId: context.actor.subjectId,
    subjectGeneration: context.actor.subjectGeneration,
  });
}
