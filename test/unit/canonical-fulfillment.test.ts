import { createHash } from "node:crypto";
import { create, toBinary } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { describe, expect, it } from "vitest";
import {
  CanonicalFulfillmentTransactionV1Schema,
  CommittedFulfillmentOutputKind,
  FulfillmentAcquisitionSourceKind,
  FulfillmentTransactionState,
} from "../../src/generated/proto/kokoro/platform/commerce/v1/fulfillment_pb.js";
import {
  canonicalFulfillmentTransaction,
  fulfillmentOutputDigest,
  type CanonicalFulfillmentInput,
  type CommittedOutputKind,
  type FulfillmentOutputCommitment,
} from "../../src/modules/commerce/domain/canonical-fulfillment.js";
import { commerceCanonicalJson } from
  "../../src/modules/commerce/domain/canonical-json.js";

describe("canonical fulfillment transaction", () => {
  it("matches the independent Root protobuf digest for every committed output kind", () => {
    const input = goldenInput();
    const expectedTransaction = independentRootTransaction(input);
    const expectedDigest = typedDigest(toBinary(
      CanonicalFulfillmentTransactionV1Schema,
      expectedTransaction,
      { writeUnknownFields: false },
    ));

    const committed = canonicalFulfillmentTransaction(input);
    const legacyDigest = legacyJsonDigest(input);

    expect(CanonicalFulfillmentTransactionV1Schema.typeName)
      .toBe("kokoro.platform.commerce.v1.CanonicalFulfillmentTransactionV1");
    expect(expectedDigest).toBe(
      "f1e25cfd8486f712413657ed0a9849239d634016a29acb45879f9a4d3fa62154",
    );
    expect(legacyDigest).toBe(
      "cf7ae2906ad41c1c23586f90c1c04f69db45de998a8d84d73c1af2f1b408fed6",
    );
    expect(expectedTransaction.outputs.map(({ kind }) => kind)).toEqual([
      CommittedFulfillmentOutputKind.SUBSCRIPTION_TERM,
      CommittedFulfillmentOutputKind.ENTITLEMENT_GRANT,
      CommittedFulfillmentOutputKind.CREDIT_GRANT,
      CommittedFulfillmentOutputKind.CREDIT_PROGRAM_ENROLLMENT,
    ]);
    expect(input.outputs.map((item) => item.outputOrdinal)).toEqual([4, 3, 2, 1]);
    expect(committed.outputs.map((item) => item.outputOrdinal)).toEqual([1, 2, 3, 4]);
    expect(committed.transactionVersion).toBe(1);
    expect(committed.transactionDigest).toBe(expectedDigest);
    expect(committed.transactionDigest).not.toBe(legacyDigest);
  });

  it("binds millisecond timestamps and uint64 values without JavaScript number coercion", () => {
    const input = goldenInput();
    const baseline = canonicalFulfillmentTransaction(input).transactionDigest;
    const mutations: CanonicalFulfillmentInput[] = [
      { ...input, acquisition: { ...input.acquisition,
        sourceVersion: input.acquisition.sourceVersion + 1n } },
      { ...input, program: { ...input.program,
        fulfillmentProgramRevision: input.program.fulfillmentProgramRevision - 1n } },
      { ...input, acquisition: { ...input.acquisition,
        acquiredAt: "2026-07-30T02:00:00.124Z" } },
      { ...input, committedAt: "2026-07-30T02:00:01.988Z" },
      { ...input, outputs: input.outputs.map((item) => item.kind === "credit_grant"
        ? output("credit_grant", item.outputOrdinal, "mutated") : item) },
    ];

    for (const mutation of mutations) {
      expect(canonicalFulfillmentTransaction(mutation).transactionDigest).not.toBe(baseline);
    }
  });

  it("rejects owner output digest drift before a fulfillment can be committed", () => {
    const input = goldenInput();
    const actual = input.outputs[0]!;
    expect(() => canonicalFulfillmentTransaction({
      ...input,
      outputs: [{ ...actual, outputDigest: "f".repeat(64) }],
    })).toThrow("FULFILLMENT_OUTPUT_DIGEST_MISMATCH");
  });
});

function goldenInput(): CanonicalFulfillmentInput {
  return Object.freeze({
    platformTransactionRef: "transaction-golden-v1",
    siteRef: "site-golden",
    acquisition: Object.freeze({
      sourceKind: "payment" as const,
      sourceRef: "settlement-golden",
      sourceVersion: 9_007_199_254_740_993n,
      sourceDigest: "a".repeat(64),
      acquiredAt: "2026-07-30T02:00:00.123Z",
    }),
    program: Object.freeze({
      fulfillmentProgramRevisionRef: "program-golden-v1",
      fulfillmentProgramRevision: 9_223_372_036_854_775_807n,
      fulfillmentProgramDigest: "b".repeat(64),
    }),
    outputs: Object.freeze([
      output("credit_program_enrollment", 4),
      output("credit_grant", 3),
      output("entitlement_grant", 2),
      output("subscription_term", 1),
    ]),
    committedAt: "2026-07-30T02:00:01.987Z",
  });
}

function independentRootTransaction(input: CanonicalFulfillmentInput) {
  const kinds: Readonly<Record<CommittedOutputKind, CommittedFulfillmentOutputKind>> = Object.freeze({
    subscription_term: CommittedFulfillmentOutputKind.SUBSCRIPTION_TERM,
    entitlement_grant: CommittedFulfillmentOutputKind.ENTITLEMENT_GRANT,
    credit_grant: CommittedFulfillmentOutputKind.CREDIT_GRANT,
    credit_program_enrollment: CommittedFulfillmentOutputKind.CREDIT_PROGRAM_ENROLLMENT,
  });
  return create(CanonicalFulfillmentTransactionV1Schema, {
    platformTransactionRef: input.platformTransactionRef,
    siteRef: input.siteRef,
    acquisition: {
      sourceKind: FulfillmentAcquisitionSourceKind.FUTURE_PAYMENT_RESERVED,
      sourceRef: input.acquisition.sourceRef,
      sourceVersion: input.acquisition.sourceVersion,
      sourceDigest: input.acquisition.sourceDigest,
      acquiredAt: timestampFromDate(new Date(input.acquisition.acquiredAt)),
    },
    program: {
      fulfillmentProgramRevisionRef: input.program.fulfillmentProgramRevisionRef,
      fulfillmentProgramRevision: input.program.fulfillmentProgramRevision,
      fulfillmentProgramDigest: input.program.fulfillmentProgramDigest,
    },
    outputs: [...input.outputs]
      .sort((left, right) => left.outputOrdinal - right.outputOrdinal ||
        left.occurrence - right.occurrence)
      .map((item) => ({
        kind: kinds[item.kind],
        outputLineId: item.outputLineId,
        outputOrdinal: item.outputOrdinal,
        occurrence: item.occurrence,
        outputRef: item.outputRef,
        outputVersion: BigInt(item.outputVersion),
        outputDigest: item.outputDigest,
      })),
    state: FulfillmentTransactionState.COMMITTED,
    transactionVersion: 1n,
    committedAt: timestampFromDate(new Date(input.committedAt)),
  });
}

function legacyJsonDigest(input: CanonicalFulfillmentInput): string {
  const outputs = [...input.outputs].sort((left, right) =>
    left.outputOrdinal - right.outputOrdinal || left.occurrence - right.occurrence);
  return typedDigest(commerceCanonicalJson({
    version: 1,
    platformTransactionRef: input.platformTransactionRef,
    siteRef: input.siteRef,
    acquisition: {
      ...input.acquisition,
      sourceVersion: input.acquisition.sourceVersion.toString(),
    },
    program: {
      ...input.program,
      fulfillmentProgramRevision: input.program.fulfillmentProgramRevision.toString(),
    },
    outputs,
    state: "committed",
    transactionVersion: 1,
    committedAt: input.committedAt,
  }));
}

function typedDigest(payload: Uint8Array | string): string {
  return createHash("sha256")
    .update(CanonicalFulfillmentTransactionV1Schema.typeName, "utf8")
    .update(Buffer.from([0]))
    .update(payload)
    .digest("hex");
}

function output(
  kind: CommittedOutputKind,
  outputOrdinal: number,
  suffix = "golden",
): FulfillmentOutputCommitment {
  const base = {
    kind,
    outputLineId: `line-${outputOrdinal}`,
    outputOrdinal,
    occurrence: 1,
    outputRef: `${kind}:${suffix}`,
    templateRevisionRef: `${kind}:template:v1`,
    outputVersion: 1 as const,
  };
  return Object.freeze({ ...base, outputDigest: fulfillmentOutputDigest(base) });
}
