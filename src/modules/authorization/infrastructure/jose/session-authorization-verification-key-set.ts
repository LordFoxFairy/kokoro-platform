import { createHash } from "node:crypto";
import { exportJWK, importSPKI } from "jose";
import type { SessionAuthorizationVerificationKeySet } from "../../application/contracts/session-authorization-ports.js";

export interface AuthorizationPublicVerificationKeyConfig {
  readonly purpose: "event_signing" | "session_access_grant";
  readonly keyRevision: string;
  readonly publicKeyPem: string;
  readonly current: boolean;
  readonly notBefore: string;
  readonly notAfter: string;
}

export async function createSessionAuthorizationVerificationKeySet(
  keys: readonly AuthorizationPublicVerificationKeyConfig[],
): Promise<SessionAuthorizationVerificationKeySet> {
  if (keys.length < 2 || keys.length > 16) throw new Error("AUTHORIZATION_VERIFICATION_KEY_SET_INVALID");
  const now = Date.now();
  const identities = new Set<string>();
  const imported = await Promise.all(keys.map(async (key) => {
    const identity = `${key.purpose}\0${key.keyRevision}`;
    if (
      !/^[A-Za-z0-9_-]{1,128}$/u.test(key.keyRevision) || identities.has(identity) ||
      !key.publicKeyPem.includes("BEGIN PUBLIC KEY")
    ) throw new Error("AUTHORIZATION_VERIFICATION_KEY_INVALID");
    identities.add(identity);
    const notBefore = instant(key.notBefore);
    const notAfter = instant(key.notAfter);
    if (Date.parse(notBefore) > now || Date.parse(notAfter) <= now || Date.parse(notAfter) <= Date.parse(notBefore)) {
      throw new Error("AUTHORIZATION_VERIFICATION_KEY_WINDOW_INVALID");
    }
    const jwk = await exportJWK(await importSPKI(key.publicKeyPem, "RS256"));
    return Object.freeze({
      purpose: key.purpose,
      keyRevision: key.keyRevision,
      current: key.current,
      notBefore,
      notAfter,
      canonicalPublicJwkJson: canonicalJson({ ...jwk, alg: "RS256", kid: key.keyRevision, use: "sig" }),
    });
  }));
  for (const purpose of ["event_signing", "session_access_grant"] as const) {
    if (imported.filter((key) => key.purpose === purpose && key.current).length !== 1) {
      throw new Error("AUTHORIZATION_VERIFICATION_SINGLE_CURRENT_KEY_REQUIRED");
    }
  }
  const ordered = [...imported].sort((left, right) =>
    left.purpose.localeCompare(right.purpose) || left.keyRevision.localeCompare(right.keyRevision));
  const keySetRevision = createHash("sha256").update(canonicalJson(ordered)).digest("hex");
  return Object.freeze({
    keySetRevision,
    verificationKeys: () => Object.freeze(ordered.map((key) => Object.freeze({ ...key }))),
  });
}

function instant(value: string): string {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw new Error("AUTHORIZATION_VERIFICATION_KEY_WINDOW_INVALID");
  return new Date(milliseconds).toISOString();
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error("AUTHORIZATION_VERIFICATION_KEY_JSON_INVALID");
    return encoded;
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
}
