import { canonicalCommandId } from "../../../shared/outbox-inbox/receipt.js";
import type { VerifiedRequestSecurityContext } from "../../../shared/security-context/index.js";
import type { PlatformUnitOfWork } from "../../../shared/unit-of-work/index.js";
import type { CreditProgramCatalogRepository,
  CreditProgramPublicationOutcome } from "./contracts/credit-program-catalog.js";
import { defineCreditProgramRevision, type CreditProgramDefinition } from
  "../domain/credit-program-catalog.js";

export class CreditProgramCatalogService {
  constructor(private readonly dependencies: Readonly<{
    unitOfWork: Pick<PlatformUnitOfWork, "execute">;
    repository: CreditProgramCatalogRepository;
    clock?: () => string;
  }>) {}

  publishRevision(input: Readonly<{
    commandId: string;
    idempotencyKey: string;
    requestDigest: string;
    programRef: string;
    revision: bigint;
    expectedVersion: bigint;
    definition: CreditProgramDefinition;
    definitionBytes: Uint8Array;
    reason: string;
  }>, context: VerifiedRequestSecurityContext): Promise<CreditProgramPublicationOutcome> {
    assertContext(context);
    const commandId = canonicalCommandId(input.commandId);
    if (input.idempotencyKey.length < 16 || input.idempotencyKey.length > 256 ||
        control(input.idempotencyKey)) throw new Error("CREDIT_PROGRAM_IDEMPOTENCY_KEY_INVALID");
    if (!/^[a-f0-9]{64}$/u.test(input.requestDigest)) {
      throw new Error("CREDIT_PROGRAM_REQUEST_DIGEST_INVALID");
    }
    if (input.reason.length < 3 || input.reason.length > 512 || control(input.reason)) {
      throw new Error("CREDIT_PROGRAM_REASON_INVALID");
    }
    const operation = "credit.program.publish" as const;
    const candidate = defineCreditProgramRevision({
      programRef: input.programRef, revision: input.revision, expectedVersion: input.expectedVersion,
      definition: input.definition, definitionBytes: input.definitionBytes,
      publishedAt: (this.dependencies.clock ?? (() => new Date().toISOString()))(),
    });
    const command = Object.freeze({
      commandId, idempotencyKey: input.idempotencyKey, requestDigest: input.requestDigest,
      environment: context.environment, region: context.region,
      callerIdentity: context.trustedCaller.workloadIdentityId,
      actorSubjectId: context.actor.subjectId, operation,
      expectedVersion: input.expectedVersion, reason: input.reason,
    });
    return this.dependencies.unitOfWork.execute({ context, operation },
      (transaction) => this.dependencies.repository.publishRevision(transaction, command, candidate));
  }
}

function assertContext(context: VerifiedRequestSecurityContext): void {
  if (context.trustedCaller.kind !== "admin_workload" || context.actor.kind !== "operator" ||
      context.target.siteId !== null || context.target.purpose !== "credit.program.publish" ||
      !context.target.scopes.includes("admin:global") ||
      !context.target.scopes.includes("credit.program.publish")) {
    throw new Error("CREDIT_PROGRAM_GLOBAL_OPERATOR_REQUIRED");
  }
}

function control(value: string): boolean {
  return [...value].some((character) => {
    const point = character.codePointAt(0) ?? 0;
    return point < 32 || point === 127;
  });
}
