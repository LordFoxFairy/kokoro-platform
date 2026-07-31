import { types as nodeTypes } from "node:util";

export type DataRecordSnapshot = Readonly<Record<string, unknown>>;
const dataRecordSnapshots = new WeakSet<object>();

export function snapshotDataRecord(value: unknown, code: string): DataRecordSnapshot {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(code);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error(code);
  const descriptors = Object.getOwnPropertyDescriptors(value) as Record<string, PropertyDescriptor>;
  const ownKeys = Reflect.ownKeys(descriptors);
  if (ownKeys.some((key) => typeof key !== "string")) throw new Error(code);
  const snapshot = Object.create(null) as Record<string, unknown>;
  for (const key of ownKeys as string[]) {
    const descriptor = descriptors[key];
    if (descriptor === undefined || !("value" in descriptor)) throw new Error(code);
    Object.defineProperty(snapshot, key, { value: descriptor.value, enumerable: true,
      configurable: false, writable: false });
  }
  const frozen = Object.freeze(snapshot);
  dataRecordSnapshots.add(frozen);
  return frozen;
}

export function requireExactDataRecordSnapshot(
  snapshot: DataRecordSnapshot,
  keys: readonly string[],
  code: string,
): DataRecordSnapshot {
  const ownKeys = Object.keys(snapshot);
  if (ownKeys.length !== keys.length || ownKeys.some((key) => !keys.includes(key))) {
    throw new Error(code);
  }
  return snapshot;
}

export function snapshotExactDataRecord(
  value: unknown,
  keys: readonly string[],
  code: string,
): DataRecordSnapshot {
  if (value !== null && typeof value === "object" && dataRecordSnapshots.has(value)) {
    return requireExactDataRecordSnapshot(value as DataRecordSnapshot, keys, code);
  }
  return requireExactDataRecordSnapshot(snapshotDataRecord(value, code), keys, code);
}

export function snapshotDenseArray(
  value: unknown,
  maximum: number,
  code: string,
  maximumExceededCode = code,
): readonly unknown[] {
  if (!Number.isSafeInteger(maximum) || maximum < 0) throw new Error(code);
  if (!Array.isArray(value) || nodeTypes.isProxy(value) ||
      Object.getPrototypeOf(value) !== Array.prototype) throw new Error(code);
  const initialLengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (initialLengthDescriptor === undefined || !("value" in initialLengthDescriptor) ||
      typeof initialLengthDescriptor.value !== "number" ||
      !Number.isSafeInteger(initialLengthDescriptor.value) || initialLengthDescriptor.value < 0) {
    throw new Error(code);
  }
  const length = initialLengthDescriptor.value;
  if (length > maximum) throw new Error(maximumExceededCode);
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== length + 1 || ownKeys.some((key) => typeof key !== "string")) {
    throw new Error(code);
  }
  const snapshot: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !("value" in descriptor)) throw new Error(code);
    snapshot.push(descriptor.value);
  }
  const finalLengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (finalLengthDescriptor === undefined || !("value" in finalLengthDescriptor) ||
      finalLengthDescriptor.value !== length) throw new Error(code);
  return Object.freeze(snapshot);
}
