import { createHash } from "node:crypto";
import { modelProducts, type ModelProduct } from "../domain/model-catalog.js";

const quarantineReasonCodes = [
  "INVALID_LABEL_FACT",
  "DUPLICATE_LABEL_KEY",
  "LABEL_WITHOUT_MODELS",
  "DEFAULT_BINDING_UNKNOWN",
  "ORPHAN_BINDING_LABEL",
  "ORPHAN_POLICY_LABEL",
] as const;
type QuarantineReasonCode = (typeof quarantineReasonCodes)[number];

export interface LegacyModelOptionMigrationArtifact {
  readonly schemaVersion: 1;
  readonly artifactDigest: string;
  readonly sourceCounts: {
    readonly labels: number;
    readonly orphanBindingLabels: number;
    readonly orphanPolicyLabels: number;
  };
  readonly options: readonly {
    readonly legacyLabelId: string;
    readonly key: string;
    readonly product: ModelProduct;
    readonly displayName: string;
    readonly description: string | null;
    readonly tier: string | null;
    readonly defaultModelKey: string | null;
    readonly candidateModelKeys: readonly string[];
    readonly enabled: boolean;
  }[];
  readonly quarantine: readonly {
    readonly sourceKind: "label" | "binding" | "policy";
    readonly safeSourceRef: string;
    readonly labelKeyDigest: string;
    readonly reasonCode: QuarantineReasonCode;
  }[];
}

interface LegacyLabelFact {
  readonly legacyLabelId: string;
  readonly key: string;
  readonly displayName: string;
  readonly description: string | null;
  readonly featureKey: string;
  readonly tier: string | null;
  readonly defaultBindingId: string | null;
  readonly status: "active" | "disabled";
}

interface LegacyBindingLabelFact {
  readonly legacyBindingId: string;
  readonly modelKey: string;
  readonly labelKeys: readonly string[];
  readonly priority: number;
}

export function createLegacyModelOptionMigrationArtifact(input: {
  readonly labels: readonly LegacyLabelFact[];
  readonly bindings: readonly LegacyBindingLabelFact[];
  readonly referencedLabelKeys: readonly string[];
}): LegacyModelOptionMigrationArtifact {
  const bindings = [...input.bindings]
    .map((binding) => ({
      legacyBindingId: text(binding.legacyBindingId),
      modelKey: identifier(binding.modelKey),
      labelKeys: [...new Set(binding.labelKeys)].sort(canonicalCompare),
      priority: position(binding.priority),
    }))
    .sort(
      (left, right) =>
        left.priority - right.priority || canonicalCompare(left.modelKey, right.modelKey),
    );
  const rawLabelKeys = new Set(input.labels.map((label) => label.key));
  const duplicateKeys = new Set(
    input.labels
      .map((label) => label.key)
      .filter((key, index, values) => values.indexOf(key) !== index),
  );
  const options: LegacyModelOptionMigrationArtifact["options"][number][] = [];
  const quarantine: LegacyModelOptionMigrationArtifact["quarantine"][number][] = [];

  for (const label of input.labels) {
    const safeSourceRef = safeRef("label", label.legacyLabelId);
    const labelKeyDigest = sha256(
      typeof label.key === "string" ? label.key : stableJson(label.key),
    );
    if (duplicateKeys.has(label.key)) {
      quarantine.push({
        sourceKind: "label",
        safeSourceRef,
        labelKeyDigest,
        reasonCode: "DUPLICATE_LABEL_KEY",
      });
      continue;
    }
    let parsed: Omit<
      LegacyModelOptionMigrationArtifact["options"][number],
      "candidateModelKeys" | "defaultModelKey"
    >;
    try {
      parsed = {
        legacyLabelId: text(label.legacyLabelId),
        key: identifier(label.key),
        product: product(label.featureKey),
        displayName: text(label.displayName),
        description: label.description === null ? null : text(label.description),
        tier: label.tier === null ? null : identifier(label.tier),
        enabled: status(label.status) === "active",
      };
    } catch {
      quarantine.push({
        sourceKind: "label",
        safeSourceRef,
        labelKeyDigest,
        reasonCode: "INVALID_LABEL_FACT",
      });
      continue;
    }
    const candidates = bindings
      .filter((binding) => binding.labelKeys.includes(parsed.key))
      .map((binding) => binding.modelKey);
    if (candidates.length === 0) {
      quarantine.push({
        sourceKind: "label",
        safeSourceRef,
        labelKeyDigest,
        reasonCode: "LABEL_WITHOUT_MODELS",
      });
      continue;
    }
    const defaultBinding =
      label.defaultBindingId === null
        ? null
        : bindings.find((binding) => binding.legacyBindingId === label.defaultBindingId);
    if (
      label.defaultBindingId !== null &&
      (!defaultBinding || !defaultBinding.labelKeys.includes(parsed.key))
    ) {
      quarantine.push({
        sourceKind: "label",
        safeSourceRef,
        labelKeyDigest,
        reasonCode: "DEFAULT_BINDING_UNKNOWN",
      });
      continue;
    }
    const defaultModelKey = defaultBinding?.modelKey ?? null;
    options.push(deepFreeze({ ...parsed, defaultModelKey, candidateModelKeys: candidates }));
  }

  const orphanBindingKeys = [...new Set(bindings.flatMap((binding) => binding.labelKeys))]
    .filter((key) => !rawLabelKeys.has(key))
    .sort(canonicalCompare);
  for (const key of orphanBindingKeys)
    quarantine.push({
      sourceKind: "binding",
      safeSourceRef: safeRef("binding-label", key),
      labelKeyDigest: sha256(key),
      reasonCode: "ORPHAN_BINDING_LABEL",
    });
  const orphanPolicyKeys = [...new Set(input.referencedLabelKeys)]
    .filter((key) => !rawLabelKeys.has(key))
    .sort(canonicalCompare);
  for (const key of orphanPolicyKeys)
    quarantine.push({
      sourceKind: "policy",
      safeSourceRef: safeRef("policy-label", key),
      labelKeyDigest: sha256(key),
      reasonCode: "ORPHAN_POLICY_LABEL",
    });

  options.sort((left, right) => canonicalCompare(left.key, right.key));
  quarantine.sort((left, right) =>
    canonicalCompare(
      `${left.sourceKind}:${left.safeSourceRef}:${left.reasonCode}`,
      `${right.sourceKind}:${right.safeSourceRef}:${right.reasonCode}`,
    ),
  );
  const payload = deepFreeze({
    schemaVersion: 1 as const,
    sourceCounts: {
      labels: input.labels.length,
      orphanBindingLabels: orphanBindingKeys.length,
      orphanPolicyLabels: orphanPolicyKeys.length,
    },
    options,
    quarantine,
  });
  return deepFreeze({ ...payload, artifactDigest: sha256(stableJson(payload)) });
}

export function verifyLegacyModelOptionMigrationArtifact(
  input: unknown,
): LegacyModelOptionMigrationArtifact {
  const artifact = strictRecord(
    input,
    ["schemaVersion", "artifactDigest", "sourceCounts", "options", "quarantine"],
    "MODEL_OPTION_MIGRATION_ARTIFACT_INVALID",
  );
  const digest = artifact.artifactDigest;
  if (typeof digest !== "string" || !/^[a-f0-9]{64}$/u.test(digest))
    throw new Error("MODEL_OPTION_MIGRATION_ARTIFACT_INVALID");
  if (artifact.schemaVersion !== 1) throw new Error("MODEL_OPTION_MIGRATION_ARTIFACT_INVALID");
  const counts = strictRecord(
    artifact.sourceCounts,
    ["labels", "orphanBindingLabels", "orphanPolicyLabels"],
    "MODEL_OPTION_MIGRATION_ARTIFACT_INVALID",
  );
  const sourceCounts = {
    labels: nonNegativeInteger(counts.labels),
    orphanBindingLabels: nonNegativeInteger(counts.orphanBindingLabels),
    orphanPolicyLabels: nonNegativeInteger(counts.orphanPolicyLabels),
  };
  const options = unknownArray(artifact.options).map((candidate) => {
    const option = strictRecord(
      candidate,
      [
        "legacyLabelId",
        "key",
        "product",
        "displayName",
        "description",
        "tier",
        "defaultModelKey",
        "candidateModelKeys",
        "enabled",
      ],
      "MODEL_OPTION_MIGRATION_ARTIFACT_INVALID",
    );
    const candidateModelKeys = unknownArray(option.candidateModelKeys).map((value) =>
      identifier(text(value)),
    );
    if (
      candidateModelKeys.length < 1 ||
      new Set(candidateModelKeys).size !== candidateModelKeys.length
    )
      throw new Error("MODEL_OPTION_MIGRATION_ARTIFACT_INVALID");
    const defaultModelKey =
      option.defaultModelKey === null ? null : identifier(text(option.defaultModelKey));
    if (defaultModelKey !== null && !candidateModelKeys.includes(defaultModelKey))
      throw new Error("MODEL_OPTION_MIGRATION_ARTIFACT_INVALID");
    if (typeof option.enabled !== "boolean")
      throw new Error("MODEL_OPTION_MIGRATION_ARTIFACT_INVALID");
    return deepFreeze({
      legacyLabelId: text(option.legacyLabelId),
      key: identifier(text(option.key)),
      product: product(text(option.product)),
      displayName: text(option.displayName),
      description: option.description === null ? null : text(option.description),
      tier: option.tier === null ? null : identifier(text(option.tier)),
      defaultModelKey,
      candidateModelKeys,
      enabled: option.enabled,
    });
  });
  if (
    options.some(
      (option, index) => index > 0 && canonicalCompare(options[index - 1]!.key, option.key) >= 0,
    )
  )
    throw new Error("MODEL_OPTION_MIGRATION_ARTIFACT_INVALID");
  const quarantine = unknownArray(artifact.quarantine).map((candidate) => {
    const item = strictRecord(
      candidate,
      ["sourceKind", "safeSourceRef", "labelKeyDigest", "reasonCode"],
      "MODEL_OPTION_MIGRATION_ARTIFACT_INVALID",
    );
    const sourceKind = item.sourceKind;
    const reasonCode = item.reasonCode;
    if (
      !isQuarantineSourceKind(sourceKind) ||
      !isQuarantineReasonCode(reasonCode) ||
      typeof item.safeSourceRef !== "string" ||
      !/^(?:label|binding-label|policy-label):sha256:[a-f0-9]{64}$/u.test(item.safeSourceRef) ||
      typeof item.labelKeyDigest !== "string" ||
      !/^[a-f0-9]{64}$/u.test(item.labelKeyDigest) ||
      !quarantineFactMatches(sourceKind, reasonCode, item.safeSourceRef)
    )
      throw new Error("MODEL_OPTION_MIGRATION_ARTIFACT_INVALID");
    return deepFreeze({
      sourceKind,
      safeSourceRef: item.safeSourceRef,
      labelKeyDigest: item.labelKeyDigest,
      reasonCode,
    });
  });
  if (
    quarantine.some((item, index) => {
      if (index === 0) return false;
      const previous = quarantine[index - 1]!;
      return (
        canonicalCompare(
          `${previous.sourceKind}:${previous.safeSourceRef}:${previous.reasonCode}`,
          `${item.sourceKind}:${item.safeSourceRef}:${item.reasonCode}`,
        ) >= 0
      );
    }) ||
    sourceCounts.labels !==
      options.length + quarantine.filter((item) => item.sourceKind === "label").length ||
    sourceCounts.orphanBindingLabels !==
      quarantine.filter((item) => item.reasonCode === "ORPHAN_BINDING_LABEL").length ||
    sourceCounts.orphanPolicyLabels !==
      quarantine.filter((item) => item.reasonCode === "ORPHAN_POLICY_LABEL").length
  )
    throw new Error("MODEL_OPTION_MIGRATION_ARTIFACT_INVALID");
  const payload = deepFreeze({ schemaVersion: 1 as const, sourceCounts, options, quarantine });
  if (sha256(stableJson(payload)) !== digest)
    throw new Error("MODEL_OPTION_MIGRATION_ARTIFACT_INVALID");
  return deepFreeze({ ...payload, artifactDigest: digest });
}

function product(value: string): ModelProduct {
  if (!(modelProducts as readonly string[]).includes(value))
    throw new Error("MODEL_PRODUCT_INVALID");
  return value as ModelProduct;
}

function status(value: string): "active" | "disabled" {
  if (value !== "active" && value !== "disabled") throw new Error("MODEL_OPTION_STATUS_INVALID");
  return value;
}

function isQuarantineSourceKind(value: unknown): value is "label" | "binding" | "policy" {
  return value === "label" || value === "binding" || value === "policy";
}

function isQuarantineReasonCode(value: unknown): value is QuarantineReasonCode {
  return typeof value === "string" && (quarantineReasonCodes as readonly string[]).includes(value);
}

function quarantineFactMatches(
  sourceKind: "label" | "binding" | "policy",
  reasonCode: QuarantineReasonCode,
  safeSourceRef: string,
): boolean {
  if (sourceKind === "binding")
    return reasonCode === "ORPHAN_BINDING_LABEL" && safeSourceRef.startsWith("binding-label:");
  if (sourceKind === "policy")
    return reasonCode === "ORPHAN_POLICY_LABEL" && safeSourceRef.startsWith("policy-label:");
  return (
    safeSourceRef.startsWith("label:") &&
    reasonCode !== "ORPHAN_BINDING_LABEL" &&
    reasonCode !== "ORPHAN_POLICY_LABEL"
  );
}

function identifier(value: string): string {
  if (!/^[a-z0-9][a-z0-9._:-]{0,127}$/u.test(value)) throw new Error("MODEL_IDENTIFIER_INVALID");
  return value;
}

function position(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 10_000)
    throw new Error("MODEL_POSITION_INVALID");
  return value;
}

function text(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 512 ||
    [...value].some(
      (character) => character.codePointAt(0)! < 32 || character.codePointAt(0) === 127,
    )
  )
    throw new Error("MODEL_TEXT_INVALID");
  return value;
}

function safeRef(kind: string, value: unknown): string {
  return `${kind}:sha256:${sha256(typeof value === "string" ? value : stableJson(value))}`;
}

function record(value: unknown, code: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(code);
  return value as Record<string, unknown>;
}

function strictRecord(value: unknown, allowed: readonly string[], code: string) {
  const result = record(value, code);
  if (Object.keys(result).some((key) => !allowed.includes(key))) throw new Error(code);
  return result;
}

function unknownArray(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error("MODEL_OPTION_MIGRATION_ARTIFACT_INVALID");
  return value;
}

function nonNegativeInteger(value: unknown): number {
  if (!Number.isInteger(value) || (value as number) < 0)
    throw new Error("MODEL_OPTION_MIGRATION_ARTIFACT_INVALID");
  return value as number;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => canonicalCompare(left, right))
    .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
    .join(",")}}`;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
