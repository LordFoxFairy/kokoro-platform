import { resolvePlatformTransaction } from "../../../../shared/unit-of-work/platform-transaction.js";
import { createHash } from "node:crypto";
import type {
  ModelControlRepository,
  ModelInventoryImportReceipt,
  ModelInventoryActivationReceipt,
  SiteModelPolicyChangeReceipt,
  CandidateProjection,
  ModelSelectionDecisionRecord,
  ResolveModelPolicyInput,
  ModelCandidate,
  SelectedModelRoute,
} from "../../application/contracts/model-control-ports.js";

export class PostgresModelControlRepository implements ModelControlRepository {
  async importInventory(
    transaction: Parameters<ModelControlRepository["importInventory"]>[0],
    input: Parameters<ModelControlRepository["importInventory"]>[1],
  ): Promise<ModelInventoryImportReceipt> {
    const sql = resolvePlatformTransaction(transaction);
    const rows = await sql.query<ImportFunctionRow>(
      `SELECT result_import_id AS "importId", result_source_digest AS digest, result_counts AS counts, replayed FROM platform.import_model_inventory($1::uuid,$2::text,$3::text,$4::jsonb,$5::text)`,
      [
        input.importId,
        input.inventory.digest,
        input.inventory.canonicalJson,
        JSON.stringify(input.inventory.counts),
        input.importedBy,
      ],
    );
    const receipt = rows[0];
    if (!receipt || receipt.digest !== input.inventory.digest)
      throw new Error("MODEL_INVENTORY_IMPORT_RECEIPT_INVALID");
    const counts = parseCounts(receipt.counts);
    if (!sameCounts(counts, input.inventory.counts))
      throw new Error("MODEL_INVENTORY_IMPORT_RECEIPT_INVALID");
    return {
      importId: receipt.importId,
      digest: receipt.digest,
      replayed: receipt.replayed,
      counts,
    };
  }

  async activateInventory(
    transaction: Parameters<ModelControlRepository["activateInventory"]>[0],
    input: Parameters<ModelControlRepository["activateInventory"]>[1],
  ): Promise<ModelInventoryActivationReceipt> {
    const rows = await resolvePlatformTransaction(transaction).query<ActivationFunctionRow>(
      `SELECT result_activation_id AS "activationId", result_import_id AS "importId", result_target_digest AS "targetDigest", result_expected_revision::text AS "expectedRevision", result_activated_revision::text AS "activatedRevision", replayed FROM platform.activate_model_inventory($1::uuid,$2::text,$3::bigint,$4::text)`,
      [input.activationId, input.targetDigest, input.expectedPointerRevision, input.activatedBy],
    );
    const receipt = rows[0];
    if (
      !receipt ||
      receipt.targetDigest !== input.targetDigest ||
      receipt.expectedRevision !== input.expectedPointerRevision ||
      !/^[1-9][0-9]*$/u.test(receipt.activatedRevision)
    )
      throw new Error("MODEL_INVENTORY_ACTIVATION_RECEIPT_INVALID");
    return receipt;
  }

  async putSitePolicy(
    transaction: Parameters<ModelControlRepository["putSitePolicy"]>[0],
    input: Parameters<ModelControlRepository["putSitePolicy"]>[1],
  ): Promise<SiteModelPolicyChangeReceipt> {
    const rows = await resolvePlatformTransaction(transaction).query<SitePolicyFunctionRow>(
      `SELECT result_change_id AS "changeId", result_policy_digest AS "policyDigest", result_revision::text AS revision, replayed FROM platform.put_model_site_policy($1::uuid,$2::text,$3::text,$4::text,$5::bigint)`,
      [
        input.changeId,
        input.policy.digest,
        input.policy.canonicalJson,
        input.changedBy,
        input.expectedRevision,
      ],
    );
    const receipt = rows[0];
    if (
      !receipt ||
      !/^[a-f0-9]{64}$/u.test(receipt.policyDigest) ||
      !/^[1-9][0-9]*$/u.test(receipt.revision)
    )
      throw new Error("MODEL_SITE_POLICY_RECEIPT_INVALID");
    return receipt;
  }

  async loadCandidates(
    transaction: Parameters<ModelControlRepository["loadCandidates"]>[0],
    input: ResolveModelPolicyInput,
  ): Promise<CandidateProjection> {
    const rows = await resolvePlatformTransaction(transaction).query<CandidateRow>(CANDIDATE_SQL, [
      input.siteId,
      input.product,
      input.role,
    ]);
    const first = rows[0];
    if (!first) throw new Error("MODEL_INVENTORY_NOT_ACTIVE");
    return {
      inventoryDigest: first.inventoryDigest,
      policyStatus: first.policyStatus,
      policyRevision: first.policyRevision,
      candidates: rows.filter((row) => row.modelKey !== null).map(mapCandidate),
    };
  }

  async recordSelectionDecision(
    transaction: Parameters<ModelControlRepository["recordSelectionDecision"]>[0],
    decision: ModelSelectionDecisionRecord,
  ): Promise<ModelSelectionDecisionRecord> {
    const sql = resolvePlatformTransaction(transaction);
    await sql.execute(
      `INSERT INTO platform.model_selection_decision (decision_id, decision_digest, site_id, product, route_role, request_digest, required_capabilities, inventory_digest, policy_revision, selected_model_key, selected_binding_key, selected_route, candidate_binding_keys, rejections, reason, decided_at) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9::bigint,$10,$11,$12::jsonb,$13::jsonb,$14::jsonb,$15,$16::timestamptz) ON CONFLICT (decision_id) DO NOTHING`,
      [
        decision.decisionId,
        decision.decisionDigest,
        decision.siteId,
        decision.product,
        decision.role,
        decision.requestDigest,
        JSON.stringify(decision.requiredCapabilities),
        decision.inventoryDigest,
        decision.policyRevision,
        decision.selectedModelKey,
        decision.selectedBindingKey,
        JSON.stringify(decision.selectedRoute),
        JSON.stringify(decision.candidateBindingKeys),
        JSON.stringify(decision.rejections),
        decision.reason,
        decision.decidedAt,
      ],
    );
    const persisted = await this.findSelectionDecision(transaction, decision.decisionId);
    if (!persisted) throw new Error("MODEL_SELECTION_DECISION_NOT_PERSISTED");
    return persisted;
  }

  async findSelectionDecision(
    transaction: Parameters<ModelControlRepository["findSelectionDecision"]>[0],
    decisionId: string,
  ): Promise<ModelSelectionDecisionRecord | null> {
    const rows = await resolvePlatformTransaction(transaction).query<DecisionRow>(
      `SELECT decision_id AS "decisionId", decision_digest AS "decisionDigest", site_id AS "siteId", product, route_role AS role, request_digest AS "requestDigest", required_capabilities AS "requiredCapabilities", inventory_digest AS "inventoryDigest", policy_revision::text AS "policyRevision", selected_model_key AS "selectedModelKey", selected_binding_key AS "selectedBindingKey", selected_route AS "selectedRoute", candidate_binding_keys AS "candidateBindingKeys", rejections, reason, to_char(decided_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "decidedAt" FROM platform.model_selection_decision WHERE decision_id=$1`,
      [decisionId],
    );
    return rows[0] ? mapDecision(rows[0]) : null;
  }
}

const CANDIDATE_SQL = `WITH seed AS (
  SELECT TRUE AS singleton
), active AS (
  SELECT pointer.import_id, imported.source_digest
  FROM platform.model_inventory_pointer pointer
  JOIN platform.model_inventory_import imported ON imported.import_id=pointer.import_id
  WHERE pointer.singleton=TRUE
), policy AS (
  SELECT revision.*
  FROM platform.model_site_policy_pointer pointer
  JOIN platform.model_site_policy_revision revision
    ON revision.site_id=pointer.site_id AND revision.product=pointer.product AND revision.revision=pointer.revision
  WHERE pointer.site_id=$1 AND pointer.product=$2
), catalog AS (
  SELECT CASE WHEN policy.catalog_mode='pinned' THEN pinned.import_id ELSE active.import_id END AS import_id,
         CASE WHEN policy.catalog_mode='pinned' THEN pinned.source_digest ELSE active.source_digest END AS source_digest
  FROM seed LEFT JOIN active ON TRUE LEFT JOIN policy ON TRUE
  LEFT JOIN platform.model_inventory_import pinned ON policy.catalog_mode='pinned' AND pinned.source_digest=policy.catalog_digest
), routes AS (
  SELECT route.model_key, route.position, route.required_capabilities
  FROM platform.model_product_route_snapshot route JOIN catalog ON catalog.import_id=route.import_id
  JOIN policy ON policy.assignment_mode='inherit' AND policy.enabled=TRUE
  WHERE route.product=$2 AND route.route_role=$3
  UNION ALL
  SELECT assignment.model_key, assignment.position, assignment.required_capabilities
  FROM platform.model_site_assignment_revision assignment
  JOIN policy ON policy.site_id=assignment.site_id AND policy.product=assignment.product AND policy.revision=assignment.policy_revision
    AND policy.assignment_mode='replace' AND policy.enabled=TRUE
  WHERE assignment.route_role=$3 AND assignment.enabled=TRUE
)
SELECT catalog.source_digest AS "inventoryDigest",
  CASE WHEN policy.site_id IS NULL THEN 'missing' WHEN policy.enabled THEN 'enabled' ELSE 'disabled' END AS "policyStatus",
  COALESCE(policy.revision,0)::text AS "policyRevision",
  route.model_key AS "modelKey", binding.binding_key AS "bindingKey", provider.provider_key AS "providerKey",
  binding.gateway_model_name AS "gatewayModelName", 'model_gateway' AS "executionBoundary", route.position,
  binding.priority AS "bindingPriority", provider.priority AS "providerPriority", model.input_modalities AS "inputModalities",
  model.output_modalities AS "outputModalities", model.capabilities, model.context_window AS "contextWindow",
  COALESCE(provider_availability.status,'disabled') AS "providerStatus",
  COALESCE(provider_availability.health,'unknown') AS "providerHealth",
  CASE WHEN model.enabled IS NOT TRUE THEN 'disabled' ELSE COALESCE(model_availability.status,'disabled') END AS "modelStatus",
  CASE WHEN binding.enabled THEN 'active' ELSE 'disabled' END AS "bindingStatus",
  route.required_capabilities AS "routeRequiredCapabilities"
FROM catalog LEFT JOIN policy ON TRUE LEFT JOIN routes ON TRUE
LEFT JOIN platform.model_definition_snapshot model ON model.import_id=catalog.import_id AND model.model_key=route.model_key
LEFT JOIN platform.model_provider_binding_snapshot binding ON binding.import_id=catalog.import_id AND binding.model_key=model.model_key
LEFT JOIN platform.model_provider_snapshot provider ON provider.import_id=catalog.import_id AND provider.provider_key=binding.provider_key
LEFT JOIN platform.model_provider_availability provider_availability ON provider_availability.provider_key=provider.provider_key
LEFT JOIN platform.model_definition_availability model_availability ON model_availability.model_key=model.model_key
WHERE catalog.import_id IS NOT NULL
ORDER BY route.position,binding.priority,provider.priority,binding.binding_key`;
interface ImportFunctionRow extends Record<string, unknown> {
  importId: string;
  digest: string;
  replayed: boolean;
  counts: unknown;
}
interface ActivationFunctionRow extends Record<string, unknown>, ModelInventoryActivationReceipt {}
interface SitePolicyFunctionRow extends Record<string, unknown>, SiteModelPolicyChangeReceipt {}
interface CandidateRow extends Record<string, unknown> {
  inventoryDigest: string;
  policyStatus: CandidateProjection["policyStatus"];
  policyRevision: string;
  modelKey: string | null;
  bindingKey: string;
  providerKey: string;
  gatewayModelName: string;
  executionBoundary: "model_gateway";
  position: number;
  bindingPriority: number;
  providerPriority: number;
  inputModalities: string[];
  outputModalities: string[];
  capabilities: string[];
  contextWindow: number | null;
  providerStatus: ModelCandidate["providerStatus"];
  providerHealth: ModelCandidate["providerHealth"];
  modelStatus: ModelCandidate["modelStatus"];
  bindingStatus: ModelCandidate["bindingStatus"];
  routeRequiredCapabilities: string[];
}
interface DecisionRow
  extends
    Record<string, unknown>,
    Omit<
      ModelSelectionDecisionRecord,
      "selectedRoute" | "requiredCapabilities" | "candidateBindingKeys" | "rejections"
    > {
  selectedRoute: unknown;
  requiredCapabilities: unknown;
  candidateBindingKeys: unknown;
  rejections: unknown;
}
function mapCandidate(row: CandidateRow): ModelCandidate {
  if (!row.modelKey) throw new Error("MODEL_CANDIDATE_INVALID");
  return { ...row, modelKey: row.modelKey };
}
function mapDecision(row: DecisionRow): ModelSelectionDecisionRecord {
  const selectedRoute = parseSelectedRoute(row.selectedRoute);
  if (
    (selectedRoute === null) !== (row.selectedModelKey === null) ||
    (selectedRoute === null) !== (row.selectedBindingKey === null) ||
    (selectedRoute &&
      (selectedRoute.modelKey !== row.selectedModelKey ||
        selectedRoute.bindingKey !== row.selectedBindingKey))
  )
    throw new Error("MODEL_SELECTION_DECISION_INVALID");
  const decision = {
    ...row,
    selectedRoute,
    requiredCapabilities: parseStringArray(row.requiredCapabilities),
    candidateBindingKeys: parseStringArray(row.candidateBindingKeys),
    rejections: parseRejections(row.rejections),
  };
  const { decisionDigest, ...effect } = decision;
  if (!/^[a-f0-9]{64}$/u.test(decisionDigest) || digest(effect) !== decisionDigest)
    throw new Error("MODEL_SELECTION_DECISION_DIGEST_INVALID");
  return decision;
}
function parseSelectedRoute(value: unknown): SelectedModelRoute | null {
  if (value === null) return null;
  if (!value || typeof value !== "object") throw new Error("MODEL_SELECTION_ROUTE_INVALID");
  const route = value as Record<string, unknown>;
  if (
    typeof route.modelKey !== "string" ||
    typeof route.bindingKey !== "string" ||
    typeof route.gatewayModelName !== "string" ||
    route.executionBoundary !== "model_gateway"
  )
    throw new Error("MODEL_SELECTION_ROUTE_INVALID");
  return {
    modelKey: route.modelKey,
    bindingKey: route.bindingKey,
    gatewayModelName: route.gatewayModelName,
    executionBoundary: "model_gateway",
  };
}
function parseStringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string"))
    throw new Error("MODEL_SELECTION_CANDIDATES_INVALID");
  return value;
}
function parseRejections(value: unknown): ModelSelectionDecisionRecord["rejections"] {
  if (!Array.isArray(value)) throw new Error("MODEL_SELECTION_REJECTIONS_INVALID");
  return value.map((item) => {
    if (!item || typeof item !== "object") throw new Error("MODEL_SELECTION_REJECTIONS_INVALID");
    const rejection = item as Record<string, unknown>;
    if (
      typeof rejection.modelKey !== "string" ||
      typeof rejection.bindingKey !== "string" ||
      typeof rejection.code !== "string"
    )
      throw new Error("MODEL_SELECTION_REJECTIONS_INVALID");
    return { modelKey: rejection.modelKey, bindingKey: rejection.bindingKey, code: rejection.code };
  });
}
function parseCounts(value: unknown): ModelInventoryImportReceipt["counts"] {
  if (!value || typeof value !== "object") throw new Error("MODEL_IMPORT_COUNTS_INVALID");
  const counts = value as Record<string, unknown>;
  const keys = ["providers", "models", "bindings", "productRoutes"] as const;
  if (Object.keys(counts).length !== keys.length || keys.some((key) => !(key in counts)))
    throw new Error("MODEL_IMPORT_COUNTS_INVALID");
  for (const key of keys)
    if (!Number.isInteger(counts[key]) || (counts[key] as number) < 0)
      throw new Error("MODEL_IMPORT_COUNTS_INVALID");
  return counts as unknown as ModelInventoryImportReceipt["counts"];
}
function sameCounts(
  left: ModelInventoryImportReceipt["counts"],
  right: ModelInventoryImportReceipt["counts"],
): boolean {
  return (
    left.providers === right.providers &&
    left.models === right.models &&
    left.bindings === right.bindings &&
    left.productRoutes === right.productRoutes
  );
}
function digest(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}
function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
    .join(",")}}`;
}
