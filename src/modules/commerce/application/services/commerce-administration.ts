import { createHash, randomUUID } from "node:crypto";
import type { VerifiedRequestSecurityContext } from "../../../../shared/security-context/index.js";
import type { PlatformUnitOfWork } from "../../../../shared/unit-of-work/index.js";
import { commerceCanonicalJson } from "../../domain/canonical-json.js";
import type { RedemptionCodeIssuancePort } from "../contracts/redemption-secret-port.js";
import type { CommerceAdministrationRepository } from "../contracts/commerce-administration-repository.js";

type CommandInput = Readonly<{ context: VerifiedRequestSecurityContext; commandId: string;
  idempotencyKey: string; requestDigest?: string; siteId: string }>;

export class CommerceAdministrationService {
  constructor(private readonly dependencies: Readonly<{
    unitOfWork: Pick<PlatformUnitOfWork, "execute">;
    repository: CommerceAdministrationRepository;
    codes: RedemptionCodeIssuancePort;
    reference?: () => string;
  }>) {}

  async publishOffer(input: CommandInput & Readonly<{
    productRef: string; productKind: "free" | "credit_pack" | "subscription" | "bundle";
    productVersionRef: string; productRevision: string; safeLabel: string;
    planVersion: Readonly<{ planRef: string; planVersionRef: string; revision: string; safeLabel: string;
      termAction: "none" | "new_subscription" | "extend_from_max" | "reject_if_active";
      termSeconds: string | null; stackingScope: string }> | null;
    fulfillmentProgramRevisionRef: string; fulfillmentProgramRef: string;
    fulfillmentProgramRevision: string;
    outputs: readonly Readonly<{ outputLineId: string; ordinal: number; cardinality: number;
      outputKind: "subscription_term" | "entitlement_grant" | "credit_grant";
      targetRevisionRef: string }>[];
    legalTermRefs: readonly string[];
  }>) {
    const actor = adminActor(input.context, input.siteId, "commerce.offer.publish");
    const outputs = validateOutputs(input.outputs);
    const legalTermRefs = uniqueBounded(input.legalTermRefs, 16);
    const planVersion = validatePlanVersion(input.planVersion);
    validateProductShape(input.productKind, planVersion, outputs);
    const payload = Object.freeze({
      siteId: bounded(input.siteId), productRef: bounded(input.productRef), productKind: input.productKind,
      productVersionRef: bounded(input.productVersionRef), productRevision: positiveInteger(input.productRevision),
      safeLabel: boundedLabel(input.safeLabel), planVersion,
      fulfillmentProgramRevisionRef: bounded(input.fulfillmentProgramRevisionRef),
      fulfillmentProgramRef: bounded(input.fulfillmentProgramRef),
      fulfillmentProgramRevision: positiveInteger(input.fulfillmentProgramRevision),
      outputs, legalTermRefs,
    });
    const offerDigest = digest({ version: 1, ...payload });
    const outputPlanDigest = digest({ version: 1, outputs });
    const command = commandIdentity(input, actor.subjectId, "commerce.offer.publish", offerDigest);
    const result = await this.dependencies.unitOfWork.execute(
      { context: input.context, operation: command.operation },
      (transaction) => this.dependencies.repository.publishOffer(transaction, {
        ...actor, command, ...payload, offerDigest, outputPlanDigest,
        planVersion: planVersion === null ? null : {
          ...planVersion, revisionDigest: digest({ version: 1, ...planVersion }),
        },
      }),
    );
    return Object.freeze({ kind: result.kind, productVersionRef: payload.productVersionRef,
      publishedAt: result.occurredAt });
  }

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
    return Object.freeze({ kind: result.kind, redemptionProgramRevisionRef: payload.redemptionProgramRevisionRef,
      publishedAt: result.occurredAt });
  }

  async issueBatch(input: CommandInput & Readonly<{
    batchRef: string; redemptionProgramRevisionRef: string; count: number; startsAt: string | null; endsAt: string | null;
  }>) {
    const actor = adminActor(input.context, input.siteId, "commerce.code-batch.issue");
    const batchRef = uuid(input.batchRef);
    const count = boundedCount(input.count, 1_000);
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
      kind: "delivery_unavailable" as const, batchRef, codeCount: count, exportedAt: result.occurredAt,
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

  async abandonBatch(input: CommandInput & Readonly<{ batchRef: string; reason: string }>) {
    return this.transitionBatch("abandon", input, this.dependencies.repository.abandonBatch.bind(this.dependencies.repository));
  }

  async suspendBatch(input: CommandInput & Readonly<{ batchRef: string; reason: string }>) {
    return this.transitionBatch("suspend", input, this.dependencies.repository.suspendBatch.bind(this.dependencies.repository));
  }

  async revokeBatch(input: CommandInput & Readonly<{ batchRef: string; reason: string }>) {
    return this.transitionBatch("revoke", input, this.dependencies.repository.revokeBatch.bind(this.dependencies.repository));
  }

  private async transitionBatch(
    action: "abandon" | "suspend" | "revoke",
    input: CommandInput & Readonly<{ batchRef: string; reason: string }>,
    effect: CommerceAdministrationRepository[`${typeof action}Batch`],
  ) {
    const operation = `commerce.code-batch.${action}`;
    const actor = adminActor(input.context, input.siteId, operation);
    const batchRef = uuid(input.batchRef);
    const reason = boundedReason(input.reason);
    const reasonDigest = digest({ version: 1, siteId: input.siteId, batchRef, reason });
    const command = commandIdentity(input, actor.subjectId, operation, reasonDigest);
    const result = await this.dependencies.unitOfWork.execute(
      { context: input.context, operation },
      (transaction) => effect(transaction, { ...actor, command, batchRef, reasonDigest }),
    );
    return Object.freeze({ kind: result, batchRef });
  }
}

function adminActor(context: VerifiedRequestSecurityContext, siteId: string, operation: string) {
  if (context.trustedCaller.kind !== "admin_workload" || context.actor.kind !== "operator" ||
    context.target.siteId !== siteId || context.target.purpose !== operation) throw new Error("COMMERCE_ADMIN_NOT_AUTHORIZED");
  return Object.freeze({ siteId, subjectId: context.actor.subjectId, subjectGeneration: context.actor.subjectGeneration });
}
function commandIdentity(input: CommandInput, subjectId: string, operation: string, requestDigest: string) {
  const authoritativeDigest = input.requestDigest ?? requestDigest;
  if (!/^[a-f0-9]{64}$/u.test(authoritativeDigest)) throw new Error("COMMERCE_ADMIN_DIGEST_INVALID");
  return Object.freeze({ commandId: uuid(input.commandId), environment: input.context.environment, region: input.context.region,
    callerIdentity: `${input.context.trustedCaller.workloadIdentityId}:${subjectId}`, operation,
    idempotencyKey: bounded(input.idempotencyKey), requestDigest: authoritativeDigest });
}
function digest(value: Parameters<typeof commerceCanonicalJson>[0]): string { return createHash("sha256").update(commerceCanonicalJson(value)).digest("hex"); }
function bounded(value: string): string { if (value.length < 1 || value.length > 256) throw new Error("COMMERCE_ADMIN_INPUT_INVALID"); return value; }
function boundedLabel(value: string): string { if (value.length < 1 || value.length > 160) throw new Error("COMMERCE_ADMIN_LABEL_INVALID"); return value; }
function boundedReason(value: string): string { if (value.length < 1 || value.length > 1000) throw new Error("COMMERCE_ADMIN_REASON_INVALID"); return value; }
function uuid(value: string): string { if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value)) throw new Error("COMMERCE_ADMIN_UUID_INVALID"); return value; }
function positiveInteger(value: string): string { if (!/^[1-9][0-9]*$/u.test(value)) throw new Error("COMMERCE_ADMIN_REVISION_INVALID"); return value; }
function boundedCount(value: number, maximum: number): number { if (!Number.isInteger(value) || value < 1 || value > maximum) throw new Error("COMMERCE_ADMIN_COUNT_INVALID"); return value; }
function nullableInstant(value: string | null): string | null { if (value === null) return null; const parsed = new Date(value); if (!Number.isFinite(parsed.getTime())) throw new Error("COMMERCE_ADMIN_TIME_INVALID"); return parsed.toISOString(); }
function one(values: readonly string[], code: string): string { const unique = new Set(values); if (unique.size !== 1) throw new Error(code); return values[0]!; }
function uniqueBounded(values: readonly string[], maximum: number): readonly string[] {
  if (values.length > maximum || new Set(values).size !== values.length) throw new Error("COMMERCE_ADMIN_COLLECTION_INVALID");
  return Object.freeze(values.map(bounded).sort());
}
function validatePlanVersion(value: Readonly<{ planRef: string; planVersionRef: string; revision: string;
  safeLabel: string; termAction: "none" | "new_subscription" | "extend_from_max" | "reject_if_active";
  termSeconds: string | null; stackingScope: string }> | null) {
  if (value === null) return null;
  const termSeconds = value.termSeconds === null ? null : positiveInteger(value.termSeconds);
  if ((value.termAction === "none") !== (termSeconds === null)) throw new Error("COMMERCE_PLAN_TERM_INVALID");
  return Object.freeze({ planRef: bounded(value.planRef), planVersionRef: bounded(value.planVersionRef),
    revision: positiveInteger(value.revision), safeLabel: boundedLabel(value.safeLabel),
    termAction: value.termAction, termSeconds, stackingScope: bounded(value.stackingScope) });
}
function validateOutputs(values: readonly Readonly<{ outputLineId: string; ordinal: number; cardinality: number;
  outputKind: "subscription_term" | "entitlement_grant" | "credit_grant"; targetRevisionRef: string }>[]) {
  if (values.length < 1 || values.length > 100) throw new Error("COMMERCE_OFFER_OUTPUTS_INVALID");
  const lineIds = new Set<string>();
  return Object.freeze(values.map((value, index) => {
    if (value.ordinal !== index || lineIds.has(value.outputLineId) || !Number.isInteger(value.cardinality) ||
      value.cardinality < 1 || value.cardinality > 100 ||
      (value.outputKind === "subscription_term" && value.cardinality !== 1)) {
      throw new Error("COMMERCE_OFFER_OUTPUT_INVALID");
    }
    lineIds.add(value.outputLineId);
    return Object.freeze({ outputLineId: bounded(value.outputLineId), ordinal: value.ordinal,
      cardinality: value.cardinality, outputKind: value.outputKind,
      targetRevisionRef: bounded(value.targetRevisionRef) });
  }));
}
function validateProductShape(
  productKind: "free" | "credit_pack" | "subscription" | "bundle",
  planVersion: ReturnType<typeof validatePlanVersion>,
  outputs: ReturnType<typeof validateOutputs>,
): void {
  const subscriptionOutputs = outputs.filter((output) => output.outputKind === "subscription_term");
  if (subscriptionOutputs.length > 0 && (planVersion === null ||
    subscriptionOutputs.some((output) => output.targetRevisionRef !== planVersion.planVersionRef))) {
    throw new Error("COMMERCE_OFFER_PLAN_OUTPUT_MISMATCH");
  }
  if (planVersion !== null && subscriptionOutputs.length !== 1) {
    throw new Error("COMMERCE_OFFER_PLAN_OUTPUT_REQUIRED");
  }
  if (productKind === "subscription" && planVersion === null) {
    throw new Error("COMMERCE_SUBSCRIPTION_PLAN_REQUIRED");
  }
  if (productKind === "credit_pack" && (planVersion !== null ||
    !outputs.some((output) => output.outputKind === "credit_grant"))) {
    throw new Error("COMMERCE_CREDIT_PACK_OUTPUT_REQUIRED");
  }
}
