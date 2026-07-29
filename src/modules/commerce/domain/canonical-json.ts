export function commerceCanonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("COMMERCE_CANONICAL_VALUE_INVALID");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(commerceCanonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right, "en"));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${commerceCanonicalJson(item)}`).join(",")}}`;
  }
  throw new Error("COMMERCE_CANONICAL_VALUE_INVALID");
}
