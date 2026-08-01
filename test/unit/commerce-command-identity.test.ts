import { describe, expect, it } from "vitest";
import {
  createCommerceCommandIdentity,
  commerceCallerIdentity,
} from "../../src/modules/commerce/domain/command-identity.js";
import {
  compileFulfillmentOutputPlan,
  validateActualOutputSet,
} from "../../src/modules/commerce/domain/output-line.js";

const digest = "a".repeat(64);

describe("Commerce command and output truth", () => {
  it("freezes a Site-scoped idempotency identity without ambiguous concatenation", () => {
    const identity = createCommerceCommandIdentity({
      commandId: "0123456789abcdef0123456789abcdef",
      environment: "production",
      region: "us-east-1",
      siteId: "site:a",
      actorKind: "user",
      actorSubject: "user|1",
      actorGeneration: "9",
      operation: "confirmRedemption",
      idempotencyKey: "idem-1",
      commandVersion: "2026-07-28",
      requestDigest: digest,
    });

    expect(identity.callerIdentity).toBe(commerceCallerIdentity("site:a", "user", "user|1", "9"));
    expect(identity.callerIdentity).not.toBe(commerceCallerIdentity("site", "user", "a:user|1", "9"));
    expect(() => createCommerceCommandIdentity({ ...identity, commandId: "00000000-0000-4000-8000-000000000001" })).toThrow("COMMAND_ID_INVALID");
    expect(Object.isFrozen(identity)).toBe(true);
    expect(() => createCommerceCommandIdentity({ ...identity, requestDigest: "bad" })).toThrow(
      "SHA256_DIGEST_REQUIRED",
    );
  });

  it("requires immutable line ids, continuous ordinals and valid disposition cardinality", () => {
    const plan = compileFulfillmentOutputPlan([
      line("subscription", 1, "required", 1),
      line("credit", 2, "optional", 2),
      line("term", 3, "forbidden", 0),
    ]);

    expect(plan.map((item) => item.outputLineId)).toEqual(["subscription", "credit", "term"]);
    expect(() => compileFulfillmentOutputPlan([line("a", 1, "required", 1), line("b", 3, "required", 1)])).toThrow(
      "OUTPUT_ORDINAL_NOT_CONTINUOUS",
    );
    expect(() => compileFulfillmentOutputPlan([line("a", 1, "forbidden", 1)])).toThrow(
      "FORBIDDEN_OUTPUT_CARDINALITY_INVALID",
    );
  });

  it("validates the actual output multiset exactly", () => {
    const plan = compileFulfillmentOutputPlan([
      line("subscription", 1, "required", 1),
      line("credit", 2, "optional", 2),
      line("term", 3, "forbidden", 0),
    ]);
    const actual = [
      actualLine("subscription", 1, "subscription"),
      actualLine("credit", 1, "credit_grant"),
      actualLine("credit", 2, "credit_grant"),
    ];

    expect(validateActualOutputSet(plan, actual)).toEqual(actual);
    expect(() => validateActualOutputSet(plan, actual.slice(1))).toThrow("REQUIRED_OUTPUT_MISSING");
    expect(() => validateActualOutputSet(plan, [...actual, actualLine("term", 1, "subscription_term")])).toThrow(
      "FORBIDDEN_OUTPUT_PRESENT",
    );
    expect(() => validateActualOutputSet(plan, [...actual, actualLine("credit", 2, "credit_grant")])).toThrow(
      "ACTUAL_OUTPUT_IDENTITY_DUPLICATE",
    );
  });
});

function line(
  outputLineId: string,
  ordinal: number,
  disposition: "required" | "optional" | "forbidden",
  cardinality: number,
) {
  const outputKind = outputLineId === "credit" ? "credit_grant" as const : outputLineId === "term" ? "subscription_term" as const : "subscription" as const;
  return { outputLineId, ordinal, disposition, cardinality, outputKind, templateRevision: `${outputLineId}:v1` };
}

function actualLine(outputLineId: string, occurrence: number, outputKind: "subscription" | "subscription_term" | "credit_grant") {
  const outputOrdinal = outputLineId === "subscription" ? 1 : outputLineId === "credit" ? 2 : 3;
  return { outputLineId, outputOrdinal, occurrence, outputKind, templateRevision: `${outputLineId}:v1`,
    outputRef: `${outputLineId}-${occurrence}`, outputVersion: 1 as const, outputDigest: "a".repeat(64) };
}
