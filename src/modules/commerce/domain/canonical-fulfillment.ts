import { createHash } from "node:crypto";
import { create, toBinary } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import {
  CanonicalFulfillmentTransactionV1Schema,
  CommittedFulfillmentOutputKind,
  FulfillmentAcquisitionSourceKind,
  FulfillmentTransactionState,
} from "../../../generated/proto/kokoro/platform/commerce/v1/fulfillment_pb.js";
import { commerceCanonicalJson } from "./canonical-json.js";

const SHA256 = /^[a-f0-9]{64}$/u;

export type CommittedOutputKind = "subscription_term" | "entitlement_grant" | "credit_grant" |
  "credit_program_enrollment";

export type FulfillmentOutputCommitment = Readonly<{
  kind: CommittedOutputKind;
  outputLineId: string;
  outputOrdinal: number;
  occurrence: number;
  outputRef: string;
  templateRevisionRef: string;
  outputVersion: 1;
  outputDigest: string;
}>;

export type CanonicalFulfillmentInput = Readonly<{
  platformTransactionRef: string;
  siteRef: string;
  acquisition: Readonly<{
    sourceKind: "redemption" | "payment" | "admin_grant" | "program_window";
    sourceRef: string;
    sourceVersion: bigint;
    sourceDigest: string;
    acquiredAt: string;
  }>;
  program: Readonly<{
    fulfillmentProgramRevisionRef: string;
    fulfillmentProgramRevision: bigint;
    fulfillmentProgramDigest: string;
  }>;
  outputs: readonly FulfillmentOutputCommitment[];
  committedAt: string;
}>;

export type CanonicalFulfillment = CanonicalFulfillmentInput & Readonly<{
  transactionVersion: 1;
  transactionDigest: string;
  outputSetDigest: string;
}>;

export function canonicalFulfillmentTransaction(input: CanonicalFulfillmentInput): CanonicalFulfillment {
  reference(input.platformTransactionRef, 256, "FULFILLMENT_TRANSACTION_REF_INVALID");
  reference(input.siteRef, 256, "FULFILLMENT_SITE_INVALID");
  reference(input.acquisition.sourceRef, 256, "FULFILLMENT_SOURCE_REF_INVALID");
  positiveVersion(input.acquisition.sourceVersion, "FULFILLMENT_SOURCE_VERSION_INVALID");
  sha256(input.acquisition.sourceDigest, "FULFILLMENT_SOURCE_DIGEST_INVALID");
  const acquiredAt = instant(input.acquisition.acquiredAt, "FULFILLMENT_ACQUIRED_AT_INVALID");
  reference(input.program.fulfillmentProgramRevisionRef, 256, "FULFILLMENT_PROGRAM_REVISION_REF_INVALID");
  positiveVersion(input.program.fulfillmentProgramRevision, "FULFILLMENT_PROGRAM_REVISION_INVALID");
  sha256(input.program.fulfillmentProgramDigest, "FULFILLMENT_PROGRAM_DIGEST_INVALID");
  const committedAt = instant(input.committedAt, "FULFILLMENT_COMMITTED_AT_INVALID");
  if (Date.parse(committedAt) < Date.parse(acquiredAt)) throw new Error("FULFILLMENT_COMMIT_BEFORE_ACQUISITION");
  const outputs = canonicalOutputs(input.outputs);
  const transaction = create(CanonicalFulfillmentTransactionV1Schema, {
    platformTransactionRef: input.platformTransactionRef,
    siteRef: input.siteRef,
    acquisition: {
      sourceKind: sourceKind(input.acquisition.sourceKind),
      sourceRef: input.acquisition.sourceRef,
      sourceVersion: input.acquisition.sourceVersion,
      sourceDigest: input.acquisition.sourceDigest,
      acquiredAt: timestampFromDate(new Date(acquiredAt)),
    },
    program: {
      fulfillmentProgramRevisionRef: input.program.fulfillmentProgramRevisionRef,
      fulfillmentProgramRevision: input.program.fulfillmentProgramRevision,
      fulfillmentProgramDigest: input.program.fulfillmentProgramDigest,
    },
    outputs: outputs.map((output) => ({
      kind: outputKind(output.kind),
      outputLineId: output.outputLineId,
      outputOrdinal: output.outputOrdinal,
      occurrence: output.occurrence,
      outputRef: output.outputRef,
      outputVersion: BigInt(output.outputVersion),
      outputDigest: output.outputDigest,
    })),
    state: FulfillmentTransactionState.COMMITTED,
    transactionVersion: 1n,
    committedAt: timestampFromDate(new Date(committedAt)),
  });
  const hash = createHash("sha256");
  hash.update(CanonicalFulfillmentTransactionV1Schema.typeName, "utf8");
  hash.update(Buffer.from([0]));
  hash.update(toBinary(CanonicalFulfillmentTransactionV1Schema, transaction, {
    writeUnknownFields: false,
  }));
  return Object.freeze({
    platformTransactionRef: input.platformTransactionRef,
    siteRef: input.siteRef,
    acquisition: Object.freeze({ ...input.acquisition, acquiredAt }),
    program: Object.freeze({ ...input.program }),
    outputs,
    committedAt,
    transactionVersion: 1 as const,
    transactionDigest: hash.digest("hex"),
    outputSetDigest: fulfillmentOutputSetDigest(outputs),
  });
}

export function fulfillmentOutputDigest(
  output: Omit<FulfillmentOutputCommitment, "outputDigest">,
): string {
  return createHash("sha256").update(commerceCanonicalJson({
    version: 1,
    kind: output.kind,
    outputLineId: output.outputLineId,
    outputOrdinal: output.outputOrdinal,
    occurrence: output.occurrence,
    resourceRef: output.outputRef,
    templateRevisionRef: output.templateRevisionRef,
    outputVersion: output.outputVersion,
  }), "utf8").digest("hex");
}

export function fulfillmentOutputSetDigest(outputs: readonly FulfillmentOutputCommitment[]): string {
  return createHash("sha256").update(commerceCanonicalJson({ version: 1, outputs }), "utf8").digest("hex");
}

function canonicalOutputs(input: readonly FulfillmentOutputCommitment[]): readonly FulfillmentOutputCommitment[] {
  if (input.length < 1 || input.length > 32) throw new Error("FULFILLMENT_OUTPUT_COUNT_INVALID");
  const outputs = [...input].sort((left, right) =>
    left.outputOrdinal - right.outputOrdinal || left.occurrence - right.occurrence);
  const refs = new Set<string>();
  const identities = new Set<string>();
  const lineToOrdinal = new Map<string, number>();
  const ordinalToLine = new Map<number, string>();
  const occurrences = new Map<string, number[]>();
  for (const output of outputs) {
    reference(output.outputLineId, 128, "FULFILLMENT_OUTPUT_LINE_INVALID");
    reference(output.outputRef, 256, "FULFILLMENT_OUTPUT_REF_INVALID");
    reference(output.templateRevisionRef, 256, "FULFILLMENT_OUTPUT_TEMPLATE_INVALID");
    if (!/^[a-z0-9][a-z0-9._:-]{0,127}$/u.test(output.outputLineId) ||
        !Number.isInteger(output.outputOrdinal) || output.outputOrdinal < 1 || output.outputOrdinal > 32 ||
        !Number.isInteger(output.occurrence) || output.occurrence < 1 || output.occurrence > 65_535 ||
        output.outputVersion !== 1) throw new Error("FULFILLMENT_OUTPUT_IDENTITY_INVALID");
    sha256(output.outputDigest, "FULFILLMENT_OUTPUT_DIGEST_INVALID");
    if (fulfillmentOutputDigest(output) !== output.outputDigest) {
      throw new Error("FULFILLMENT_OUTPUT_DIGEST_MISMATCH");
    }
    if (refs.has(output.outputRef)) throw new Error("FULFILLMENT_OUTPUT_REF_DUPLICATE");
    refs.add(output.outputRef);
    const identity = `${output.kind}\u0000${output.outputRef}\u0000${output.outputVersion}\u0000${output.outputDigest}`;
    if (identities.has(identity)) throw new Error("FULFILLMENT_OUTPUT_IDENTITY_DUPLICATE");
    identities.add(identity);
    const knownOrdinal = lineToOrdinal.get(output.outputLineId);
    const knownLine = ordinalToLine.get(output.outputOrdinal);
    if ((knownOrdinal !== undefined && knownOrdinal !== output.outputOrdinal) ||
        (knownLine !== undefined && knownLine !== output.outputLineId)) {
      throw new Error("FULFILLMENT_OUTPUT_LINE_ORDINAL_DRIFT");
    }
    lineToOrdinal.set(output.outputLineId, output.outputOrdinal);
    ordinalToLine.set(output.outputOrdinal, output.outputLineId);
    occurrences.set(output.outputLineId, [...(occurrences.get(output.outputLineId) ?? []), output.occurrence]);
  }
  for (const values of occurrences.values()) {
    if (values.some((value, index) => value !== index + 1)) {
      throw new Error("FULFILLMENT_OUTPUT_OCCURRENCE_GAP");
    }
  }
  return Object.freeze(outputs.map((output) => Object.freeze({
    kind: output.kind,
    outputLineId: output.outputLineId,
    outputOrdinal: output.outputOrdinal,
    occurrence: output.occurrence,
    outputRef: output.outputRef,
    templateRevisionRef: output.templateRevisionRef,
    outputVersion: output.outputVersion,
    outputDigest: output.outputDigest,
  })));
}

function sourceKind(
  kind: CanonicalFulfillmentInput["acquisition"]["sourceKind"],
): FulfillmentAcquisitionSourceKind {
  if (kind === "redemption") return FulfillmentAcquisitionSourceKind.REDEMPTION;
  if (kind === "payment") return FulfillmentAcquisitionSourceKind.FUTURE_PAYMENT_RESERVED;
  if (kind === "admin_grant") return FulfillmentAcquisitionSourceKind.ADMIN_GRANT;
  return FulfillmentAcquisitionSourceKind.PROGRAM_WINDOW;
}

function outputKind(kind: CommittedOutputKind): CommittedFulfillmentOutputKind {
  if (kind === "subscription_term") return CommittedFulfillmentOutputKind.SUBSCRIPTION_TERM;
  if (kind === "entitlement_grant") return CommittedFulfillmentOutputKind.ENTITLEMENT_GRANT;
  if (kind === "credit_program_enrollment") {
    return CommittedFulfillmentOutputKind.CREDIT_PROGRAM_ENROLLMENT;
  }
  return CommittedFulfillmentOutputKind.CREDIT_GRANT;
}

function reference(value: string, maximum: number, code: string): void {
  if (value.length < 1 || value.length > maximum || value.trim() !== value ||
      [...value].some((character) => character.codePointAt(0)! < 32)) throw new Error(code);
}

function positiveVersion(value: bigint, code: string): void {
  if (value < 1n || value > 18_446_744_073_709_551_615n) throw new Error(code);
}

function sha256(value: string, code: string): void {
  if (!SHA256.test(value)) throw new Error(code);
}

function instant(value: string, code: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) throw new Error(code);
  return value;
}
