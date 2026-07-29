import { createHash } from "node:crypto";
import type { CanonicalizedModelInventory } from "../domain/model-catalog.js";
import {
  compileModelOptionRevision,
  type ModelOptionRevision,
} from "../domain/product-model-option.js";
import {
  verifyLegacyModelOptionMigrationArtifact,
  type LegacyModelOptionMigrationArtifact,
} from "./legacy-model-option-artifact.js";

export interface ModelOptionMaterializationQuarantine {
  readonly safeSourceRef: string;
  readonly sourceArtifactDigest: string;
  readonly optionKeyDigest: string;
  readonly reasonCode:
    | `LEGACY_${LegacyModelOptionMigrationArtifact["quarantine"][number]["reasonCode"]}`
    | "MODEL_OPTION_GENERATION_ROUTE_REQUIRED"
    | "MODEL_OPTION_ORCHESTRATION_ROLE_REQUIRED"
    | "MODEL_OPTION_DEFAULT_MODEL_UNAVAILABLE"
    | "MODEL_OPTION_FACT_INVALID";
}

export interface LegacyModelOptionMaterialization {
  readonly schemaVersion: 1;
  readonly compilerVersion: "model-option-compiler.v1";
  readonly artifactDigest: string;
  readonly inventoryDigest: string;
  readonly materializationDigest: string;
  readonly optionRevisions: readonly ModelOptionRevision[];
  readonly quarantine: readonly ModelOptionMaterializationQuarantine[];
}

export function materializeLegacyModelOptionArtifact(input: {
  readonly inventory: CanonicalizedModelInventory;
  readonly artifact: LegacyModelOptionMigrationArtifact;
}): LegacyModelOptionMaterialization {
  const artifact = verifyLegacyModelOptionMigrationArtifact(input.artifact);
  const optionRevisions: ModelOptionRevision[] = [];
  const quarantine: ModelOptionMaterializationQuarantine[] = artifact.quarantine.map((item) => ({
    safeSourceRef: item.safeSourceRef,
    sourceArtifactDigest: artifact.artifactDigest,
    optionKeyDigest: item.labelKeyDigest,
    reasonCode: `LEGACY_${item.reasonCode}`,
  }));
  for (const option of artifact.options) {
    try {
      optionRevisions.push(compileModelOptionRevision({ inventory: input.inventory, option }));
    } catch (error) {
      quarantine.push({
        safeSourceRef: `option:sha256:${sha256(option.legacyLabelId)}`,
        sourceArtifactDigest: artifact.artifactDigest,
        optionKeyDigest: sha256(option.key),
        reasonCode: materializationReason(error),
      });
    }
  }
  optionRevisions.sort((left, right) => canonicalCompare(left.optionKey, right.optionKey));
  quarantine.sort((left, right) =>
    canonicalCompare(
      `${left.safeSourceRef}:${left.reasonCode}:${left.optionKeyDigest}`,
      `${right.safeSourceRef}:${right.reasonCode}:${right.optionKeyDigest}`,
    ),
  );
  const payload = deepFreeze({
    schemaVersion: 1 as const,
    compilerVersion: "model-option-compiler.v1" as const,
    artifactDigest: artifact.artifactDigest,
    inventoryDigest: input.inventory.digest,
    optionRevisions,
    quarantine,
  });
  return deepFreeze({ ...payload, materializationDigest: sha256(stableJson(payload)) });
}

function materializationReason(error: unknown): ModelOptionMaterializationQuarantine["reasonCode"] {
  if (!(error instanceof Error)) return "MODEL_OPTION_FACT_INVALID";
  if (
    error.message === "MODEL_OPTION_GENERATION_ROUTE_REQUIRED" ||
    error.message === "MODEL_OPTION_ORCHESTRATION_ROLE_REQUIRED" ||
    error.message === "MODEL_OPTION_DEFAULT_MODEL_UNAVAILABLE"
  )
    return error.message;
  return "MODEL_OPTION_FACT_INVALID";
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
