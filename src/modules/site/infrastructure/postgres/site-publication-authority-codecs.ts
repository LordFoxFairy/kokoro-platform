import { z } from "zod";
import type { ImmutableRevisionBinding } from "../../domain/site-publication-authority.js";

export const prefixedDigestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
export const positiveDecimalSchema = z.string().regex(/^[1-9][0-9]*$/u).refine((value) =>
  BigInt(value) <= 18_446_744_073_709_551_615n);
export const authorityReferenceSchema = z.string().min(3).max(256).refine((value) =>
  value === value.normalize("NFC") && !hasControlCharacter(value));
export const canonicalInstantSchema = z.string().datetime({ offset: false, precision: 3 }).refine((value) =>
  new Date(value).toISOString() === value);

export const wireRevisionBindingSchema = z.object({
  ref: authorityReferenceSchema,
  revision: positiveDecimalSchema,
  digest: prefixedDigestSchema,
}).strict();

export const digestReferenceSchema = z.object({
  ref: authorityReferenceSchema,
  digest: prefixedDigestSchema,
}).strict();

export function revisionBinding(
  value: z.infer<typeof wireRevisionBindingSchema>,
): ImmutableRevisionBinding {
  return Object.freeze({ ref: value.ref, revision: BigInt(value.revision), digest: value.digest });
}

export function positiveDecimal(value: unknown, code: string): bigint {
  const parsed = positiveDecimalSchema.safeParse(value);
  if (!parsed.success) throw new Error(code);
  return BigInt(parsed.data);
}

export function digest(value: unknown, code: string): string {
  const parsed = prefixedDigestSchema.safeParse(value);
  if (!parsed.success) throw new Error(code);
  return parsed.data;
}

export function reference(value: unknown, code: string): string {
  const parsed = authorityReferenceSchema.safeParse(value);
  if (!parsed.success) throw new Error(code);
  return parsed.data;
}

export function canonicalInstant(value: unknown, code: string): string {
  const parsed = canonicalInstantSchema.safeParse(value);
  if (!parsed.success) throw new Error(code);
  return parsed.data;
}

export function bytes(value: unknown, code: string): Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength < 1 || value.byteLength > 16_384) {
    throw new Error(code);
  }
  return new Uint8Array(value);
}

export function exactlyOne<Row>(rows: readonly Row[], code: string): Row {
  if (rows.length !== 1 || rows[0] === undefined) throw new Error(code);
  return rows[0];
}

export function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === "object" && !ArrayBuffer.isView(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint < 32 || codePoint === 127;
  });
}
