import type { VerifiedRequestSecurityContext } from "../../../../shared/security-context/index.js";
import type { PlatformUnitOfWork } from "../../../../shared/unit-of-work/index.js";
import { createHash } from "node:crypto";
import { modelProducts } from "../../domain/model-catalog.js";
import type {
  ModelCandidate,
  ModelControlApplication,
  ModelControlRepository,
  ResolveModelPolicyInput,
  ResolveModelPolicyResult,
} from "../contracts/model-control-ports.js";

export class ResolveModelPolicyService implements ModelControlApplication {
  constructor(
    private readonly unitOfWork: PlatformUnitOfWork,
    private readonly repository: ModelControlRepository,
    private readonly clock: () => string = () => new Date().toISOString(),
  ) {}
  async resolve(
    input: ResolveModelPolicyInput,
    context: VerifiedRequestSecurityContext,
  ): Promise<ResolveModelPolicyResult> {
    validateInput(input);
    const requiredCapabilities = [...input.requiredCapabilities].sort();
    const requestDigest = digestDecision({
      siteId: input.siteId,
      product: input.product,
      role: input.role,
      requiredCapabilities,
    });
    if (
      context.target.siteId !== input.siteId ||
      (context.trustedCaller.kind === "site_product" &&
        context.trustedCaller.siteId !== input.siteId)
    )
      throw new Error("MODEL_SITE_SCOPE_MISMATCH");
    return this.unitOfWork.execute(
      { context, operation: "model.policy.resolve" },
      async (transaction) => {
        const existing = await this.repository.findSelectionDecision(transaction, input.decisionId);
        if (existing) {
          assertSameRequest(existing, input, requestDigest, requiredCapabilities);
          return resultFromDecision(existing);
        }
        const projection = await this.repository.loadCandidates(transaction, input);
        const candidates = [...projection.candidates].sort(
          (a, b) =>
            a.position - b.position ||
            healthRank(a.providerHealth) - healthRank(b.providerHealth) ||
            a.bindingPriority - b.bindingPriority ||
            a.providerPriority - b.providerPriority ||
            a.bindingKey.localeCompare(b.bindingKey),
        );
        const rejections: { modelKey: string; bindingKey: string; code: string }[] = [];
        let selected: ModelCandidate | undefined;
        if (projection.policyStatus === "enabled")
          for (const candidate of candidates) {
            const code = rejection(candidate, requiredCapabilities);
            if (code)
              rejections.push({
                modelKey: candidate.modelKey,
                bindingKey: candidate.bindingKey,
                code,
              });
            else {
              selected = candidate;
              break;
            }
          }
        const reason =
          projection.policyStatus === "disabled"
            ? "site_product_disabled"
            : projection.policyStatus === "missing"
              ? "site_policy_missing"
              : selected
                ? rejections.length > 0
                  ? `fallback_after_${rejections[0]!.code}`
                  : selected.providerHealth === "healthy"
                    ? "primary_available"
                    : `primary_provider_${selected.providerHealth}`
                : (rejections[0]?.code ?? "no_assignment");
        const selectedRoute = selected
          ? {
              modelKey: selected.modelKey,
              bindingKey: selected.bindingKey,
              gatewayModelName: selected.gatewayModelName,
              executionBoundary: "model_gateway" as const,
            }
          : null;
        const decidedAt = canonicalInstant(this.clock());
        const decision = {
          decisionId: input.decisionId,
          siteId: input.siteId,
          product: input.product,
          role: input.role,
          requestDigest,
          requiredCapabilities,
          inventoryDigest: projection.inventoryDigest,
          policyRevision: projection.policyRevision,
          selectedModelKey: selected?.modelKey ?? null,
          selectedBindingKey: selected?.bindingKey ?? null,
          selectedRoute,
          candidateBindingKeys: candidates.map((item) => item.bindingKey),
          rejections,
          reason,
          decidedAt,
        };
        const persisted = await this.repository.recordSelectionDecision(transaction, {
          ...decision,
          decisionDigest: digestDecision(decision),
        });
        assertSameRequest(persisted, input, requestDigest, requiredCapabilities);
        return resultFromDecision(persisted);
      },
    );
  }
}
function assertSameRequest(
  decision: Parameters<ModelControlRepository["recordSelectionDecision"]>[1],
  input: ResolveModelPolicyInput,
  requestDigest: string,
  requiredCapabilities: readonly string[],
): void {
  if (
    decision.siteId !== input.siteId ||
    decision.product !== input.product ||
    decision.role !== input.role ||
    decision.requestDigest !== requestDigest ||
    !sameStrings(decision.requiredCapabilities, requiredCapabilities)
  )
    throw new Error("MODEL_SELECTION_DECISION_CONFLICT");
}
function resultFromDecision(
  decision: Parameters<ModelControlRepository["recordSelectionDecision"]>[1],
): ResolveModelPolicyResult {
  return decision.selectedRoute
    ? {
        kind: "selected",
        selected: decision.selectedRoute,
        inventoryDigest: decision.inventoryDigest,
        policyRevision: decision.policyRevision,
        reason: decision.reason,
      }
    : {
        kind: "unavailable",
        inventoryDigest: decision.inventoryDigest,
        policyRevision: decision.policyRevision,
        reason: decision.reason,
      };
}
function rejection(candidate: ModelCandidate, requested: readonly string[]): string | null {
  if (candidate.providerStatus !== "active") return "provider_disabled";
  if (candidate.providerHealth === "down") return "provider_down";
  if (candidate.modelStatus !== "active") return "model_disabled";
  if (candidate.bindingStatus !== "active") return "binding_disabled";
  if (
    ![...candidate.routeRequiredCapabilities, ...requested].every((item) =>
      candidate.capabilities.includes(item),
    )
  )
    return "capability_mismatch";
  return null;
}
function healthRank(value: ModelCandidate["providerHealth"]): number {
  return value === "healthy" ? 0 : value === "degraded" ? 1 : value === "unknown" ? 2 : 3;
}
function validateInput(input: ResolveModelPolicyInput): void {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      input.decisionId,
    )
  )
    throw new Error("MODEL_DECISION_ID_INVALID");
  if (!/^[a-z0-9][a-z0-9._:-]{0,127}$/u.test(input.siteId))
    throw new Error("MODEL_SITE_ID_INVALID");
  if (!(modelProducts as readonly string[]).includes(input.product))
    throw new Error("MODEL_PRODUCT_INVALID");
  if (input.role !== "main" && input.role !== "generation")
    throw new Error("MODEL_ROUTE_ROLE_INVALID");
  if (
    input.requiredCapabilities.length > 32 ||
    new Set(input.requiredCapabilities).size !== input.requiredCapabilities.length ||
    input.requiredCapabilities.some((item) => !/^[a-z0-9][a-z0-9._:-]{0,127}$/u.test(item))
  )
    throw new Error("MODEL_REQUIRED_CAPABILITIES_INVALID");
}
function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
function canonicalInstant(value: string): string {
  const timestamp = new Date(value);
  if (!Number.isFinite(timestamp.getTime())) throw new Error("MODEL_SELECTION_CLOCK_INVALID");
  return timestamp.toISOString();
}
function digestDecision(value: object): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}
function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
    .join(",")}}`;
}
