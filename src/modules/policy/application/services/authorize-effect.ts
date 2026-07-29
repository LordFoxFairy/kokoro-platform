import type { PlatformTransaction, PlatformUnitOfWork } from "../../../../shared/unit-of-work/index.js";
import type { VerifiedRequestSecurityContext } from "../../../../shared/security-context/index.js";
import { evaluateOperationPolicy, type CallerOperationPolicy, type EffectAuthorizationFacts } from "../../domain/operation-policy.js";
import type { VerifiedRiskDecisionSnapshot } from "../../domain/index.js";

export interface EffectPolicyRepository {
  lockAuthorizationFacts(transaction: PlatformTransaction, context: VerifiedRequestSecurityContext): Promise<EffectAuthorizationFacts>;
  recordDecision(transaction: PlatformTransaction, decision: SecurityDecisionRecord): Promise<void>;
}
export interface SecurityDecisionRecord { readonly requestId: string; readonly operation: string; readonly effectPoint: string; readonly allowed: boolean; readonly reasonCode: string; readonly policyEpoch: string; readonly riskDecisionId: string | null; }
export interface EffectAuthorizationPermit { readonly operation: string; readonly effectPoint: string; readonly requestId: string; }

export async function authorizeAndExecuteEffect<Result>(input: {
  readonly unitOfWork: PlatformUnitOfWork; readonly repository: EffectPolicyRepository;
  readonly policy: CallerOperationPolicy | undefined; readonly context: VerifiedRequestSecurityContext;
  readonly riskSnapshot: VerifiedRiskDecisionSnapshot | null;
  readonly effect: (transaction: PlatformTransaction, permit: EffectAuthorizationPermit) => Promise<Result>;
}): Promise<Result> {
  const operation = input.policy?.operation ?? "unknown";
  return input.unitOfWork.execute({ context: input.context, operation }, async (transaction) => {
    const policy = input.policy;
    const facts = await input.repository.lockAuthorizationFacts(transaction, input.context);
    const decision = evaluateOperationPolicy(policy, input.context, facts, input.riskSnapshot);
    await input.repository.recordDecision(transaction, { requestId: input.context.requestId, operation: policy?.operation ?? "unknown", effectPoint: policy?.effectPoint ?? "none", allowed: decision.allowed, reasonCode: decision.allowed ? "ALLOW" : decision.code, policyEpoch: facts.currentPolicyEpoch, riskDecisionId: input.riskSnapshot?.riskDecisionId ?? null });
    if (!decision.allowed) throw new Error(`EFFECT_AUTHORIZATION_DENIED:${decision.code}`);
    if (!policy) throw new Error("OPERATION_POLICY_MISSING");
    return input.effect(transaction, Object.freeze({ operation: policy.operation, effectPoint: policy.effectPoint, requestId: input.context.requestId }));
  });
}
