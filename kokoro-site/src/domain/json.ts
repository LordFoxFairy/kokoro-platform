export type JsonValue = string | number | boolean | null | JsonObject | JsonValue[];
export interface JsonObject {
  [key: string]: JsonValue;
}

// 把外部/ORM 的宽松 JSON（含 undefined 槽）收敛为本仓的纯净 JsonValue；非 JSON 输入归一为 null。
export function coerceJsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (Array.isArray(value)) {
    return value.map(coerceJsonValue);
  }
  if (typeof value === "object") {
    const out: JsonObject = {};
    for (const [key, entry] of Object.entries(value)) {
      if (entry !== undefined) {
        out[key] = coerceJsonValue(entry);
      }
    }
    return out;
  }
  return null;
}
