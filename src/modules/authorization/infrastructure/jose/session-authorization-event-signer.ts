import { importPKCS8, importSPKI } from "jose";
import type { SessionAuthorizationEventSigner } from "../../application/contracts/session-authorization-ports.js";

export interface AuthorizationEventSigningKeyConfig {
  readonly keyRevision: string;
  readonly publicKeyPem: string;
  readonly privateKeyPem?: string;
  readonly current: boolean;
  readonly notBefore: string;
  readonly notAfter: string;
}

export interface AuthorizationEventKeyRingConfig {
  readonly keys: readonly AuthorizationEventSigningKeyConfig[];
}

export async function createSessionAuthorizationEventSigner(
  config: AuthorizationEventKeyRingConfig,
): Promise<SessionAuthorizationEventSigner> {
  if (config.keys.length < 1 || config.keys.length > 8) throw new Error("AUTHORIZATION_EVENT_KEY_RING_INVALID");
  const now = Date.now();
  const revisions = new Set<string>();
  const imported = await Promise.all(config.keys.map(async (key) => {
    if (!/^[A-Za-z0-9_-]{1,128}$/u.test(key.keyRevision) || revisions.has(key.keyRevision)) {
      throw new Error("AUTHORIZATION_EVENT_KEY_REVISION_INVALID");
    }
    revisions.add(key.keyRevision);
    const notBefore = instant(key.notBefore);
    const notAfter = instant(key.notAfter);
    if (
      Date.parse(notAfter) <= Date.parse(notBefore) || Date.parse(notBefore) > now ||
      Date.parse(notAfter) <= now || !key.publicKeyPem.includes("BEGIN PUBLIC KEY")
    ) throw new Error("AUTHORIZATION_EVENT_KEY_WINDOW_INVALID");
    if (key.current && !key.privateKeyPem?.includes("BEGIN PRIVATE KEY")) {
      throw new Error("AUTHORIZATION_EVENT_CURRENT_PRIVATE_KEY_REQUIRED");
    }
    if (!key.current && key.privateKeyPem !== undefined) {
      throw new Error("AUTHORIZATION_EVENT_PREVIOUS_PRIVATE_KEY_FORBIDDEN");
    }
    const publicKey = await importSPKI(key.publicKeyPem, "RS256");
    const privateKey = key.privateKeyPem === undefined
      ? undefined
      : await importPKCS8(key.privateKeyPem, "RS256");
    return Object.freeze({ ...key, notBefore, notAfter, publicKey, privateKey });
  }));
  const current = imported.filter((key) => key.current);
  if (current.length !== 1 || current[0]?.privateKey === undefined) {
    throw new Error("AUTHORIZATION_EVENT_SINGLE_CURRENT_KEY_REQUIRED");
  }
  const probe = new Uint8Array(32).fill(17);
  const proof = await globalThis.crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    current[0].privateKey,
    probe.buffer,
  );
  const verified = await globalThis.crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    current[0].publicKey,
    proof,
    probe.buffer,
  );
  if (!verified) throw new Error("AUTHORIZATION_EVENT_KEY_PAIR_INVALID");
  return Object.freeze({
    keyRevision: current[0].keyRevision,
    async sign(payload: Uint8Array): Promise<Uint8Array> {
      const signature = await globalThis.crypto.subtle.sign(
        "RSASSA-PKCS1-v1_5",
        current[0]!.privateKey!,
        new Uint8Array(payload).buffer as ArrayBuffer,
      );
      return new Uint8Array(signature);
    },
  });
}

function instant(value: string): string {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw new Error("AUTHORIZATION_EVENT_KEY_WINDOW_INVALID");
  return new Date(milliseconds).toISOString();
}
