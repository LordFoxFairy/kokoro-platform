import { exportJWK, importPKCS8, importSPKI, jwtVerify, SignJWT, type JWK } from "jose";
import type { SessionAccessGrantSigner } from "../../application/contracts/session-authorization-ports.js";
import type { SessionAccessGrantClaims } from "../../domain/session-access-grant.js";
import { SESSION_ACCESS_AUDIENCES, SessionAuthorizationError } from "../../domain/session-access-grant.js";

export interface SessionAccessSigningKeyConfig {
  readonly keyRevision: string;
  readonly publicKeyPem: string;
  readonly privateKeyPem?: string;
  readonly current: boolean;
}

export interface SessionAccessKeyRingConfig {
  readonly issuer: string;
  readonly maximumTtlSeconds: number;
  readonly keys: readonly SessionAccessSigningKeyConfig[];
}

type ImportedKey = Readonly<{
  keyRevision: string;
  current: boolean;
  publicKey: CryptoKey;
  privateKey?: CryptoKey;
  jwk: Readonly<Record<string, unknown>>;
}>;

export async function createSessionAccessGrantSigner(
  config: SessionAccessKeyRingConfig,
): Promise<SessionAccessGrantSigner> {
  const issuer = canonicalIssuer(config.issuer);
  if (
    !Number.isInteger(config.maximumTtlSeconds) ||
    config.maximumTtlSeconds < 30 ||
    config.maximumTtlSeconds > 300
  ) throw new Error("SESSION_ACCESS_GRANT_TTL_INVALID");
  if (config.keys.length < 1 || config.keys.length > 8) {
    throw new Error("SESSION_ACCESS_KEY_RING_INVALID");
  }
  const revisions = new Set<string>();
  const imported = await Promise.all(config.keys.map(async (item): Promise<ImportedKey> => {
    if (!/^[A-Za-z0-9_-]{1,128}$/u.test(item.keyRevision) || revisions.has(item.keyRevision)) {
      throw new Error("SESSION_ACCESS_KEY_REVISION_INVALID");
    }
    revisions.add(item.keyRevision);
    if (!item.publicKeyPem.includes("BEGIN PUBLIC KEY")) {
      throw new Error("SESSION_ACCESS_PUBLIC_KEY_INVALID");
    }
    if (item.current && !item.privateKeyPem?.includes("BEGIN PRIVATE KEY")) {
      throw new Error("SESSION_ACCESS_CURRENT_PRIVATE_KEY_REQUIRED");
    }
    if (!item.current && item.privateKeyPem !== undefined) {
      throw new Error("SESSION_ACCESS_PREVIOUS_PRIVATE_KEY_FORBIDDEN");
    }
    const publicKey = await importSPKI(item.publicKeyPem, "RS256");
    const privateKey = item.privateKeyPem === undefined
      ? undefined
      : await importPKCS8(item.privateKeyPem, "RS256");
    const exported = await exportJWK(publicKey);
    const jwk: JWK = {
      ...exported,
      alg: "RS256",
      kid: item.keyRevision,
      use: "sig",
    };
    return Object.freeze({
      keyRevision: item.keyRevision,
      current: item.current,
      publicKey,
      ...(privateKey === undefined ? {} : { privateKey }),
      jwk: Object.freeze(jwk as Record<string, unknown>),
    });
  }));
  const current = imported.filter((item) => item.current);
  if (current.length !== 1 || current[0]?.privateKey === undefined) {
    throw new Error("SESSION_ACCESS_SINGLE_CURRENT_KEY_REQUIRED");
  }

  // A private/public mismatch is deployment-invalid. Prove the pair once at startup.
  const probe = await new SignJWT({ purpose: "key-pair-probe" })
    .setProtectedHeader({ alg: "RS256", kid: current[0].keyRevision, typ: "JWT" })
    .setIssuer(issuer)
    .setAudience("session.key-pair-probe")
    .setIssuedAt()
    .setExpirationTime("30s")
    .sign(current[0].privateKey);
  await jwtVerify(probe, current[0].publicKey, {
    algorithms: ["RS256"],
    issuer,
    audience: "session.key-pair-probe",
  });

  const jwks = Object.freeze({ keys: Object.freeze(imported.map((item) => item.jwk)) });
  return Object.freeze({
    issuer,
    keyRevision: current[0].keyRevision,
    maximumTtlSeconds: config.maximumTtlSeconds,
    async sign(claims: SessionAccessGrantClaims): Promise<string> {
      if (
        claims.binding.issuer !== issuer ||
        claims.binding.keyRevision !== current[0]!.keyRevision ||
        claims.authorization.audience !== SESSION_ACCESS_AUDIENCES[claims.authorization.purpose]
      ) throw new SessionAuthorizationError("AUTHORIZATION_INPUT_INVALID");
      const issuedAt = seconds(claims.binding.issuedAt);
      const notBefore = seconds(claims.binding.notBefore);
      const expiresAt = seconds(claims.binding.expiresAt);
      if (
        expiresAt <= issuedAt ||
        expiresAt <= notBefore ||
        expiresAt - issuedAt > config.maximumTtlSeconds
      ) throw new SessionAuthorizationError("AUTHORIZATION_INPUT_INVALID");
      return new SignJWT({
        grantRef: claims.grantRef,
        binding: claims.binding,
        authorization: claims.authorization,
      })
        .setProtectedHeader({ alg: "RS256", kid: current[0]!.keyRevision, typ: "JWT" })
        .setIssuer(issuer)
        .setAudience(claims.authorization.audience)
        .setJti(claims.grantRef)
        .setIssuedAt(issuedAt)
        .setNotBefore(notBefore)
        .setExpirationTime(expiresAt)
        .sign(current[0]!.privateKey!);
    },
    jwks: () => jwks,
  });
}

function canonicalIssuer(value: string): string {
  let issuer: URL;
  try {
    issuer = new URL(value);
  } catch {
    throw new Error("SESSION_ACCESS_ISSUER_INVALID");
  }
  if (
    issuer.protocol !== "https:" ||
    issuer.username !== "" ||
    issuer.password !== "" ||
    issuer.hash !== "" ||
    issuer.search !== "" ||
    issuer.href !== value
  ) throw new Error("SESSION_ACCESS_ISSUER_INVALID");
  return value;
}

function seconds(value: string): number {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || milliseconds % 1_000 !== 0) {
    throw new SessionAuthorizationError("AUTHORIZATION_INPUT_INVALID");
  }
  return milliseconds / 1_000;
}
