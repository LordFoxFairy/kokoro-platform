import { types as nodeTypes } from "node:util";
import { isOpaqueReferenceValue } from "./references.js";
import { snapshotExactDataRecord } from "./runtime-validation.js";

const canonicalMediaRequestBrand: unique symbol = Symbol("CanonicalMediaRequest");
const Uint8ArrayConstructor = Uint8Array;
const plainUint8ArrayPrototype = Uint8Array.prototype;
const typedArrayPrototype = Object.getPrototypeOf(plainUint8ArrayPrototype) as object;
const typedArrayBufferGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, "buffer")?.get;
const typedArrayByteLengthGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteLength")?.get;
const uint8ArraySet = Uint8Array.prototype.set;

export type CanonicalMediaRequest = Readonly<{
  canonicalBytes: Uint8Array;
  callerRequestFingerprint: string;
  [canonicalMediaRequestBrand]: true;
}>;

export function canonicalMediaRequest(input: Readonly<{
  canonicalBytes: Uint8Array;
  callerRequestFingerprint: string;
}>): CanonicalMediaRequest {
  const snapshot = snapshotExactDataRecord(input, ["canonicalBytes", "callerRequestFingerprint"],
    "MEDIA_CANONICAL_REQUEST_INVALID");
  const canonicalBytes = copyCanonicalBytes(snapshot.canonicalBytes);
  if (!isOpaqueReferenceValue(snapshot.callerRequestFingerprint)) {
    throw new Error("MEDIA_CALLER_REQUEST_FINGERPRINT_INVALID");
  }
  return immutableCanonicalMediaRequest(canonicalBytes, snapshot.callerRequestFingerprint);
}

function copyCanonicalBytes(value: unknown): Uint8Array {
  try {
    if (nodeTypes.isProxy(value) || !nodeTypes.isUint8Array(value) ||
        Object.getPrototypeOf(value) !== plainUint8ArrayPrototype ||
        typedArrayBufferGetter === undefined || typedArrayByteLengthGetter === undefined) {
      throw new Error("MEDIA_CANONICAL_REQUEST_BYTES_INVALID");
    }
    const buffer = Reflect.apply(typedArrayBufferGetter, value, []) as ArrayBufferLike;
    if (nodeTypes.isSharedArrayBuffer(buffer)) throw new Error("MEDIA_CANONICAL_REQUEST_BYTES_INVALID");
    const byteLength = Reflect.apply(typedArrayByteLengthGetter, value, []) as number;
    const copy = new Uint8ArrayConstructor(byteLength);
    Reflect.apply(uint8ArraySet, copy, [value]);
    return copy;
  } catch {
    throw new Error("MEDIA_CANONICAL_REQUEST_BYTES_INVALID");
  }
}

function immutableCanonicalMediaRequest(
  canonicalBytes: Uint8Array,
  callerRequestFingerprint: string,
): CanonicalMediaRequest {
  const value = Object.create(null) as Record<PropertyKey, unknown>;
  Object.defineProperties(value, {
    canonicalBytes: { enumerable: true, configurable: false,
      get: () => new Uint8ArrayConstructor(canonicalBytes) },
    callerRequestFingerprint: { value: callerRequestFingerprint, enumerable: true,
      configurable: false, writable: false },
    [canonicalMediaRequestBrand]: { value: true, enumerable: false,
      configurable: false, writable: false },
  });
  return Object.freeze(value) as CanonicalMediaRequest;
}
