export type FulfillmentOutputKind = "subscription" | "subscription_term" | "entitlement_grant" | "credit_grant";
export type OutputDisposition = "required" | "optional" | "forbidden";

export interface FulfillmentOutputLine {
  readonly outputLineId: string;
  readonly ordinal: number;
  readonly cardinality: number;
  readonly templateRevision: string;
  readonly outputKind: FulfillmentOutputKind;
  readonly disposition: OutputDisposition;
}

export interface ActualFulfillmentOutput {
  readonly outputLineId: string;
  readonly occurrence: number;
  readonly templateRevision: string;
  readonly outputKind: FulfillmentOutputKind;
  readonly outputRef: string;
}

export interface FulfillmentOutputIdentity {
  readonly sourceType: "redemption" | "admin_grant" | "program_window";
  readonly sourceId: string;
  readonly purpose: string;
  readonly cycleKey: string;
  readonly fulfillmentProgramVersion: string;
  readonly outputLineId: string;
  readonly occurrence: number;
}

export function compileFulfillmentOutputPlan(input: readonly FulfillmentOutputLine[]): readonly FulfillmentOutputLine[] {
  if (input.length < 1 || input.length > 256) throw new Error("OUTPUT_PLAN_SIZE_INVALID");
  const ids = new Set<string>();
  const result = input.map((line, index) => {
    if (line.outputLineId.length < 1 || line.outputLineId.length > 128 || ids.has(line.outputLineId)) {
      throw new Error(ids.has(line.outputLineId) ? "OUTPUT_LINE_ID_DUPLICATE" : "OUTPUT_LINE_ID_INVALID");
    }
    ids.add(line.outputLineId);
    if (line.ordinal !== index) throw new Error("OUTPUT_ORDINAL_NOT_CONTINUOUS");
    if (!Number.isInteger(line.cardinality) || line.cardinality < 0 || line.cardinality > 100) {
      throw new Error("OUTPUT_CARDINALITY_INVALID");
    }
    if (line.disposition === "forbidden" && line.cardinality !== 0) throw new Error("FORBIDDEN_OUTPUT_CARDINALITY_INVALID");
    if (line.disposition !== "forbidden" && line.cardinality === 0) throw new Error("OUTPUT_CARDINALITY_INVALID");
    if (line.templateRevision.length < 1 || line.templateRevision.length > 256) throw new Error("OUTPUT_TEMPLATE_REVISION_INVALID");
    return Object.freeze({ ...line });
  });
  return Object.freeze(result);
}

export function validateActualOutputSet(
  plan: readonly FulfillmentOutputLine[],
  actual: readonly ActualFulfillmentOutput[],
): readonly ActualFulfillmentOutput[] {
  const byId = new Map(plan.map((line) => [line.outputLineId, line]));
  const identities = new Set<string>();
  const counts = new Map<string, number>();
  for (const item of actual) {
    if (item.outputRef.length < 1 || item.outputRef.length > 256 || [...item.outputRef].some((character) => character.codePointAt(0)! < 32)) {
      throw new Error("ACTUAL_OUTPUT_REF_INVALID");
    }
    const line = byId.get(item.outputLineId);
    if (!line) throw new Error("UNDECLARED_OUTPUT_PRESENT");
    if (line.disposition === "forbidden") throw new Error("FORBIDDEN_OUTPUT_PRESENT");
    if (item.outputKind !== line.outputKind || item.templateRevision !== line.templateRevision) throw new Error("OUTPUT_TEMPLATE_MISMATCH");
    if (!Number.isInteger(item.occurrence) || item.occurrence < 1 || item.occurrence > line.cardinality) throw new Error("OUTPUT_OCCURRENCE_INVALID");
    const identity = `${item.outputLineId}\u0000${item.occurrence}`;
    if (identities.has(identity)) throw new Error("ACTUAL_OUTPUT_IDENTITY_DUPLICATE");
    identities.add(identity);
    counts.set(item.outputLineId, (counts.get(item.outputLineId) ?? 0) + 1);
  }
  for (const line of plan) {
    const count = counts.get(line.outputLineId) ?? 0;
    if (line.disposition === "required" && count !== line.cardinality) throw new Error("REQUIRED_OUTPUT_MISSING");
    if (line.disposition === "optional" && count > line.cardinality) throw new Error("OPTIONAL_OUTPUT_CARDINALITY_EXCEEDED");
  }
  return Object.freeze(actual.map((item) => Object.freeze({ ...item })));
}
