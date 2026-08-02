import type { JsonValue } from "../../../shared/outbox-inbox/receipt.js";
import type { VerifiedRequestSecurityContext } from "../../../shared/security-context/index.js";
import type { PlatformUnitOfWork } from "../../../shared/unit-of-work/unit-of-work.js";
import type { PlatformTransaction } from "../../../shared/unit-of-work/index.js";
import type { CommerceCommandIdentity } from "../domain/command-identity.js";
import type { CommerceRepository, CommerceTerminalOutcome } from "./contracts/repository.js";
import type { CommerceEffectAuthority } from "./command-authorization.js";
import { CommerceLockSequence } from "./command-lock-order.js";

export interface CommerceCommandExecutionContext {
  readonly transaction: PlatformTransaction;
  readonly authority: CommerceEffectAuthority;
  readonly locks: CommerceLockSequence;
}

export type CommerceCommandExecutionResult =
  | { readonly disposition: "executed"; readonly state: "succeeded" | "failed"; readonly result: JsonValue | null; readonly resultDigest: string }
  | { readonly disposition: "in_progress" | "replay"; readonly receipt: { readonly state: string; readonly result: JsonValue | null; readonly resultDigest: string | null } };

export class CommerceCommandFence {
  readonly #unitOfWork: PlatformUnitOfWork;
  readonly #repository: CommerceRepository;
  readonly #authorize: (transaction: PlatformTransaction, context: VerifiedRequestSecurityContext, operation: string) => Promise<CommerceEffectAuthority>;

  constructor(
    unitOfWork: PlatformUnitOfWork,
    repository: CommerceRepository,
    authorize: (transaction: PlatformTransaction, context: VerifiedRequestSecurityContext, operation: string) => Promise<CommerceEffectAuthority>,
  ) {
    this.#unitOfWork = unitOfWork;
    this.#repository = repository;
    this.#authorize = authorize;
  }

  async execute(
    input: { readonly context: VerifiedRequestSecurityContext; readonly identity: CommerceCommandIdentity },
    work: (context: CommerceCommandExecutionContext) => Promise<CommerceTerminalOutcome>,
  ): Promise<CommerceCommandExecutionResult> {
    assertIdentityContext(input.identity, input.context);
    return this.#unitOfWork.execute({ context: input.context, operation: input.identity.operation }, async (transaction) => {
      const claim = await this.#repository.claimCommand(transaction, input.identity);
      if (claim.disposition !== "execute") return Object.freeze({ disposition: claim.disposition, receipt: claim.receipt });
      const authority = await this.#authorize(transaction, input.context, input.identity.operation);
      const outcome = await work(Object.freeze({ transaction, authority, locks: new CommerceLockSequence() }));
      await this.#repository.completeCommand(transaction, input.identity, outcome);
      return Object.freeze({ disposition: "executed" as const, ...outcome });
    });
  }
}

function assertIdentityContext(identity: CommerceCommandIdentity, context: VerifiedRequestSecurityContext): void {
  if (
    identity.environment !== context.environment || identity.region !== context.region ||
    identity.siteId !== context.trustedCaller.siteId || identity.siteId !== context.target.siteId ||
    identity.actorKind !== context.actor.kind || identity.actorSubject !== context.actor.subjectId ||
    identity.actorGeneration !== context.actor.subjectGeneration || identity.operation !== context.target.purpose
  ) throw new Error("COMMERCE_COMMAND_CONTEXT_MISMATCH");
}
