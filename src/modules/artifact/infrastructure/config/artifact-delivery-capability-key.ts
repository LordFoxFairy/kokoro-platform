const INVALID = "PLATFORM_ARTIFACT_DELIVERY_CAPABILITY_KEY_FILE_INVALID";

/** Parses the single key document shared by the JSON issuer and binary redeemer. */
export function parseArtifactDeliveryCapabilityKey(value: string): Uint8Array {
  return parseKey(value, "artifact-delivery-capability-hmac-sha256-v1", INVALID);
}

export function parseArtifactOwnerCursorKey(value: string): Uint8Array {
  return parseKey(value, "artifact-owner-cursor-hmac-sha256-v1",
    "PLATFORM_ARTIFACT_OWNER_CURSOR_KEY_FILE_INVALID");
}

function parseKey(value: string, revision: string, code: string): Uint8Array {
  let root: unknown;
  try {
    root = JSON.parse(value);
  } catch {
    invalid(code);
  }
  if (
    !record(root) ||
    Object.keys(root).sort().join(",") !== "keyBase64Url,revision,version" ||
    root.version !== 1 ||
    root.revision !== revision ||
    typeof root.keyBase64Url !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/u.test(root.keyBase64Url)
  ) {
    invalid(code);
  }
  const key = Buffer.from(root.keyBase64Url, "base64url");
  if (key.byteLength !== 32 || key.toString("base64url") !== root.keyBase64Url) invalid(code);
  return new Uint8Array(key);
}

function invalid(code: string): never {
  throw new Error(code);
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
