import { createHash } from "node:crypto";
import { commerceCanonicalJson } from "./canonical-json.js";

export type FulfillmentProgramOwnerBinding = Readonly<{
  kind: "subscription_term_policy" | "entitlement_template" | "credit_program";
  revisionRef: string;
  revision: bigint;
  revisionDigest: string;
}>;

export type CanonicalFulfillmentProgramLine = Readonly<{
  outputLineId: string;
  outputOrdinal: number;
  occurrenceCount: number;
  outputKind: "subscription_term" | "entitlement_grant" | "credit_grant";
  owner: FulfillmentProgramOwnerBinding;
}>;

/** The only digest builder for both publication and every consuming read path. */
export function canonicalFulfillmentProgramDigest(input: Readonly<{
  siteId: string;
  fulfillmentProgramRevisionRef: string;
  lines: readonly CanonicalFulfillmentProgramLine[];
}>): string {
  const lines = canonicalFulfillmentProgramLines(input.lines);
  return createHash("sha256").update(commerceCanonicalJson({
    schema: "kokoro.platform.commerce.fulfillment-program.v1",
    siteId: input.siteId,
    fulfillmentProgramRevisionRef: input.fulfillmentProgramRevisionRef,
    lines: lines.map((line) => ({ ...line, owner: { ...line.owner, revision: line.owner.revision.toString() } })),
  }), "utf8").digest("hex");
}

export function canonicalFulfillmentProgramLines(
  input: readonly CanonicalFulfillmentProgramLine[],
): readonly CanonicalFulfillmentProgramLine[] {
  if (input.length < 1 || input.length > 32 || input.reduce((sum, line) => sum + line.occurrenceCount, 0) > 32) {
    throw new Error("FULFILLMENT_PROGRAM_CARDINALITY_INVALID");
  }
  const ids = new Set<string>();
  return Object.freeze([...input].sort((left, right) => left.outputOrdinal - right.outputOrdinal).map((line, index) => {
    const expectedOwnerKind = line.outputKind === "subscription_term" ? "subscription_term_policy" :
      line.outputKind === "entitlement_grant" ? "entitlement_template" : "credit_program";
    if (line.outputOrdinal !== index + 1 || ids.has(line.outputLineId) ||
        !/^[a-z0-9][a-z0-9._:-]{0,127}$/u.test(line.outputLineId) ||
        !Number.isInteger(line.occurrenceCount) || line.occurrenceCount < 1 || line.occurrenceCount > 32 ||
        line.owner.kind !== expectedOwnerKind || line.owner.revision < 1n ||
        line.owner.revision > 9_223_372_036_854_775_807n || !/^[a-f0-9]{64}$/u.test(line.owner.revisionDigest) ||
        line.owner.revisionRef.length < 1 || line.owner.revisionRef.length > 256) {
      throw new Error("FULFILLMENT_PROGRAM_LINE_INVALID");
    }
    ids.add(line.outputLineId);
    return Object.freeze({ ...line, owner: Object.freeze({ ...line.owner }) });
  }));
}
