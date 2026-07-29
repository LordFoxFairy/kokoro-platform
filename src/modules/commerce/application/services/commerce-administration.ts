import { createHash, randomUUID } from "node:crypto";
import type { VerifiedRequestSecurityContext } from "../../../../shared/security-context/index.js";
import type { PlatformUnitOfWork } from "../../../../shared/unit-of-work/index.js";
import { commerceCanonicalJson } from "../../domain/canonical-json.js";
import type { RedemptionCodeIssuancePort } from "../contracts/redemption-secret-port.js";
import type { CommerceAdministrationRepository } from "../contracts/commerce-administration-repository.js";

type CommandInput = Readonly<{ context: VerifiedRequestSecurityContext; commandId: string; idempotencyKey: string; siteId: string }>;

export class CommerceAdministrationService {
  constructor(private readonly dependencies: Readonly<{
    unitOfWork: Pick<PlatformUnitOfWork, "execute">;
    repository: CommerceAdministrationRepository;
    codes: RedemptionCodeIssuancePort;
    reference?: () => string;
  }>) {}

  async publishProgram(input: CommandInput & Readonly<{
    redemptionProgramRevisionRef: string; programRef: string; revision: string; productVersionRef: string;
    fulfillmentProgramRevisionRef: string; maxRedemptionsPerAccount: number;
  }>) {
    const actor = adminActor(input.context, input.siteId, "commerce.redemption-program.publish");
    const payload = Object.freeze({
      siteId: input.siteId, redemptionProgramRevisionRef: bounded(input.redemptionProgramRevisionRef),
      programRef: bounded(input.programRef), revision: positiveInteger(input.revision),
      productVersionRef: bounded(input.productVersionRef), fulfillmentProgramRevisionRef: bounded(input.fulfillmentProgramRevisionRef),
      maxRedemptionsPerAccount: boundedCount(input.maxRedemptionsPerAccount, 10_000),
    });
    const command = commandIdentity(input, actor.subjectId, "commerce.redemption-program.publish", digest(payload));
    const result = await this.dependencies.unitOfWork.execute({ context: input.context, operation: command.operation }, (transaction) =>
      this.dependencies.repository.publishProgram(transaction, {
        ...actor, command, ...payload, programDigest: digest({ version: 1, ...payload }),
      }));
    return Object.freeze({ kind: result, redemptionProgramRevisionRef: payload.redemptionProgramRevisionRef });
  }

  async issueBatch(input: CommandInput & Readonly<{
    batchRef: string; redemptionProgramRevisionRef: string; count: number; startsAt: string | null; endsAt: string | null;
  }>) {
    const actor = adminActor(input.context, input.siteId, "commerce.code-batch.issue");
    const batchRef = uuid(input.batchRef);
    const count = boundedCount(input.count, 10_000);
    const redemptionProgramRevisionRef = bounded(input.redemptionProgramRevisionRef);
    const issued = Array.from({ length: count }, () => this.dependencies.codes.issueCode(input.siteId, batchRef));
    const keyRevision = one(issued.map((item) => item.keyRevision), "CODE_ISSUANCE_KEY_CHANGED");
    const batchSelector = one(issued.map((item) => item.batchSelector), "CODE_ISSUANCE_BATCH_SELECTOR_CHANGED");
    const startsAt = nullableInstant(input.startsAt); const endsAt = nullableInstant(input.endsAt);
    if (startsAt !== null && endsAt !== null && Date.parse(endsAt) <= Date.parse(startsAt)) throw new Error("CODE_BATCH_WINDOW_INVALID");
    const payload = { siteId: input.siteId, batchRef, redemptionProgramRevisionRef, count, startsAt, endsAt };
    const command = commandIdentity(input, actor.subjectId, "commerce.code-batch.issue", digest(payload));
    const rawCodes = issued.map((item) => item.code);
    const exportDigest = digest({ version: 1, batchRef, codes: rawCodes });
    const result = await this.dependencies.unitOfWork.execute({ context: input.context, operation: command.operation }, (transaction) =>
      this.dependencies.repository.issueBatch(transaction, {
        ...actor, command, batchRef, batchSelector, redemptionProgramRevisionRef, keyRevision, startsAt, endsAt, exportDigest,
        codes: issued.map((item) => Object.freeze({
          codeRef: (this.dependencies.reference ?? randomUUID)(), lookupDigest: item.lookupDigest, safeFingerprint: item.safeFingerprint,
        })),
      }));
    if (result.kind === "replayed") return Object.freeze({
      kind: "delivery_unavailable" as const, batchRef, codeCount: count,
    });
    return Object.freeze({
      kind: "secret_export" as const, batchRef, codeCount: count, codes: Object.freeze(rawCodes), exportedAt: result.occurredAt,
    });
  }

  async approveBatch(input: CommandInput & Readonly<{ batchRef: string }>) {
    const actor = adminActor(input.context, input.siteId, "commerce.code-batch.approve");
    const batchRef = uuid(input.batchRef); const approvalDigest = digest({ version: 1, siteId: input.siteId, batchRef, checker: actor.subjectId });
    const command = commandIdentity(input, actor.subjectId, "commerce.code-batch.approve", approvalDigest);
    const result = await this.dependencies.unitOfWork.execute({ context: input.context, operation: command.operation }, (transaction) =>
      this.dependencies.repository.approveBatch(transaction, { ...actor, command, batchRef, approvalDigest }));
    return Object.freeze({ kind: result, batchRef });
  }

  async activateBatch(input: CommandInput & Readonly<{ batchRef: string }>) {
    const actor = adminActor(input.context, input.siteId, "commerce.code-batch.activate");
    const batchRef = uuid(input.batchRef);
    const command = commandIdentity(input, actor.subjectId, "commerce.code-batch.activate", digest({ version: 1, siteId: input.siteId, batchRef }));
    const result = await this.dependencies.unitOfWork.execute({ context: input.context, operation: command.operation }, (transaction) =>
      this.dependencies.repository.activateBatch(transaction, { ...actor, command, batchRef }));
    return Object.freeze({ kind: result, batchRef });
  }
}

function adminActor(context: VerifiedRequestSecurityContext, siteId: string, operation: string) {
  if (context.trustedCaller.kind !== "admin_workload" || context.actor.kind !== "operator" ||
    context.target.siteId !== siteId || context.target.purpose !== operation) throw new Error("COMMERCE_ADMIN_NOT_AUTHORIZED");
  return Object.freeze({ siteId, subjectId: context.actor.subjectId, subjectGeneration: context.actor.subjectGeneration });
}
function commandIdentity(input: CommandInput, subjectId: string, operation: string, requestDigest: string) {
  return Object.freeze({ commandId: uuid(input.commandId), environment: input.context.environment, region: input.context.region,
    callerIdentity: `${input.context.trustedCaller.workloadIdentityId}:${subjectId}`, operation,
    idempotencyKey: bounded(input.idempotencyKey), requestDigest });
}
function digest(value: Parameters<typeof commerceCanonicalJson>[0]): string { return createHash("sha256").update(commerceCanonicalJson(value)).digest("hex"); }
function bounded(value: string): string { if (value.length < 1 || value.length > 256) throw new Error("COMMERCE_ADMIN_INPUT_INVALID"); return value; }
function uuid(value: string): string { if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value)) throw new Error("COMMERCE_ADMIN_UUID_INVALID"); return value; }
function positiveInteger(value: string): string { if (!/^[1-9][0-9]*$/u.test(value)) throw new Error("COMMERCE_ADMIN_REVISION_INVALID"); return value; }
function boundedCount(value: number, maximum: number): number { if (!Number.isInteger(value) || value < 1 || value > maximum) throw new Error("COMMERCE_ADMIN_COUNT_INVALID"); return value; }
function nullableInstant(value: string | null): string | null { if (value === null) return null; const parsed = new Date(value); if (!Number.isFinite(parsed.getTime())) throw new Error("COMMERCE_ADMIN_TIME_INVALID"); return parsed.toISOString(); }
function one(values: readonly string[], code: string): string { const unique = new Set(values); if (unique.size !== 1) throw new Error(code); return values[0]!; }
