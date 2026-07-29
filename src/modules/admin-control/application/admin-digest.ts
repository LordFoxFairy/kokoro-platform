import { createHash } from "node:crypto";
import type { JsonValue } from "../../../shared/outbox-inbox/receipt.js";

export function digestAdminValue(value: unknown): string {
  return createHash("sha256").update(stable(value), "utf8").digest("hex");
}

function stable(value: unknown): string {
  if (typeof value === "bigint") return JSON.stringify(value.toString());
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  return `{${Object.entries(value as Record<string, JsonValue>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${stable(child)}`)
    .join(",")}}`;
}
