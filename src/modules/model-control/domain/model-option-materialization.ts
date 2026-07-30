import { createHash } from "node:crypto";

import type { CanonicalizedModelInventory } from "./model-catalog.js";
import {
  compileModelOptionRevision,
  verifyModelOptionDraft,
  type ModelOptionDraft,
  type ModelOptionRevision,
} from "./product-model-option.js";

export interface ModelOptionDraftSet {
  readonly schemaVersion: 1;
  readonly inventoryDigest: string;
  readonly options: readonly ModelOptionDraft[];
}

export interface MaterializedModelOptions {
  readonly schemaVersion: 1;
  readonly compilerVersion: "model-option-compiler.v2";
  readonly sourceDigest: string;
  readonly inventoryDigest: string;
  readonly materializationDigest: string;
  readonly optionRevisions: readonly ModelOptionRevision[];
}

export function materializeModelOptionDraftSet(input: Readonly<{
  inventory: CanonicalizedModelInventory;
  draftSet: ModelOptionDraftSet;
}>): MaterializedModelOptions {
  const draftSet = verifyModelOptionDraftSet(input.draftSet);
  if (draftSet.inventoryDigest !== input.inventory.digest) {
    throw new Error("MODEL_OPTION_INVENTORY_DIGEST_MISMATCH");
  }
  const optionRevisions = draftSet.options.map((draft) =>
    compileModelOptionRevision({ inventory: input.inventory, draft }));
  const payload = deepFreeze({
    schemaVersion: 1 as const,
    compilerVersion: "model-option-compiler.v2" as const,
    sourceDigest: sha256(stableJson(draftSet)),
    inventoryDigest: input.inventory.digest,
    optionRevisions,
  });
  return deepFreeze({
    ...payload,
    materializationDigest: sha256(stableJson(payload)),
  });
}

export function verifyModelOptionDraftSet(input: unknown): ModelOptionDraftSet {
  const value = strictRecord(
    input,
    ["schemaVersion", "inventoryDigest", "options"],
    "MODEL_OPTION_DRAFT_SET_INVALID",
  );
  if (value.schemaVersion !== 1) throw new Error("MODEL_OPTION_DRAFT_SET_INVALID");
  const inventoryDigest = digest(value.inventoryDigest);
  if (!Array.isArray(value.options) || value.options.length < 1 || value.options.length > 256) {
    throw new Error("MODEL_OPTION_DRAFT_SET_INVALID");
  }
  const options = value.options.map(verifyModelOptionDraft)
    .sort((left, right) => canonicalCompare(left.optionKey, right.optionKey));
  if (new Set(options.map(({ optionKey }) => optionKey)).size !== options.length) {
    throw new Error("MODEL_OPTION_DRAFT_DUPLICATE");
  }
  return deepFreeze({ schemaVersion: 1 as const, inventoryDigest, options });
}

function strictRecord(value: unknown, allowed: readonly string[], code: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(code);
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !allowed.includes(key))) throw new Error(code);
  return record;
}

function digest(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) {
    throw new Error("MODEL_OPTION_INVENTORY_DIGEST_INVALID");
  }
  return value;
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
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
