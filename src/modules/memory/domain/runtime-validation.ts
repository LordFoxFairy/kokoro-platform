import { types as nodeTypes } from "node:util";
import { MemoryDomainError, type MemoryDomainErrorCode } from "./memory-error.js";

export type MemoryRecordSnapshot = Readonly<Record<string, unknown>>;

export function snapshotExactMemoryRecord(
  value: unknown,
  keys: readonly string[],
  code: MemoryDomainErrorCode,
): MemoryRecordSnapshot {
  return requireExactMemoryRecord(snapshotMemoryRecord(value, code), keys, code);
}

export function snapshotMemoryRecord(
  value: unknown,
  code: MemoryDomainErrorCode,
): MemoryRecordSnapshot {
  if (value === null || typeof value !== "object" || Array.isArray(value) || nodeTypes.isProxy(value)) {
    throw new MemoryDomainError(code);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new MemoryDomainError(code);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const ownKeys = Reflect.ownKeys(descriptors);
  if (ownKeys.some((key) => typeof key !== "string")) throw new MemoryDomainError(code);

  const snapshot = Object.create(null) as Record<string, unknown>;
  for (const key of ownKeys as string[]) {
    const descriptor = descriptors[key];
    if (descriptor === undefined) throw new MemoryDomainError(code);
    let captured: unknown;
    if ("value" in descriptor) {
      captured = descriptor.value;
    } else {
      if (descriptor.get === undefined) throw new MemoryDomainError(code);
      try {
        captured = descriptor.get.call(value);
      } catch {
        throw new MemoryDomainError(code);
      }
    }
    Object.defineProperty(snapshot, key, {
      value: captured,
      enumerable: true,
      configurable: false,
      writable: false,
    });
  }
  return Object.freeze(snapshot);
}

export function requireExactMemoryRecord(snapshot: MemoryRecordSnapshot, keys: readonly string[],
  code: MemoryDomainErrorCode): MemoryRecordSnapshot {
  const ownKeys = Object.keys(snapshot);
  if (ownKeys.length !== keys.length || ownKeys.some((key) => !keys.includes(key))) {
    throw new MemoryDomainError(code);
  }
  return snapshot;
}
