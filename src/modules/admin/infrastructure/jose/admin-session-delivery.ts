import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  randomBytes,
} from "node:crypto";
import {
  CompactEncrypt,
  SignJWT,
  importPKCS8,
  importSPKI,
} from "jose";
import type {
  AdminOidcProviderClaims,
  AdminOidcOperatorAuthority,
  AdminOidcTransaction,
} from "../../application/services/admin-oidc-service.js";

const TRANSACTION_SECRET_AAD = Buffer.from("kokoro.admin-oidc-transaction-secret.v1", "utf8");

export class AesGcmAdminOidcTransactionProtector {
  readonly #key: Buffer;

  constructor(key: Uint8Array) {
    if (!(key instanceof Uint8Array) || key.byteLength !== 32) {
      throw new Error("ADMIN_OIDC_TRANSACTION_KEY_INVALID");
    }
    this.#key = Buffer.from(key);
  }

  seal(value: string): string {
    if (value.length < 1 || value.length > 4096) throw new Error("ADMIN_OIDC_TRANSACTION_SECRET_INVALID");
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#key, nonce, { authTagLength: 16 });
    cipher.setAAD(TRANSACTION_SECRET_AAD);
    const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return ["v1", nonce.toString("base64url"), encrypted.toString("base64url"),
      cipher.getAuthTag().toString("base64url")].join(".");
  }

  open(value: string): string {
    try {
      const [version, nonceValue, ciphertextValue, tagValue, extra] = value.split(".");
      if (version !== "v1" || !nonceValue || !ciphertextValue || !tagValue || extra !== undefined) {
        throw new Error("invalid envelope");
      }
      const nonce = canonicalBase64Url(nonceValue, 12);
      const ciphertext = canonicalBase64Url(ciphertextValue);
      const tag = canonicalBase64Url(tagValue, 16);
      if (ciphertext.byteLength < 1 || ciphertext.byteLength > 4096) throw new Error("invalid ciphertext");
      const decipher = createDecipheriv("aes-256-gcm", this.#key, nonce, { authTagLength: 16 });
      decipher.setAAD(TRANSACTION_SECRET_AAD);
      decipher.setAuthTag(tag);
      return new TextDecoder("utf-8", { fatal: true }).decode(
        Buffer.concat([decipher.update(ciphertext), decipher.final()]),
      );
    } catch {
      throw new Error("ADMIN_OIDC_TRANSACTION_SECRET_INVALID");
    }
  }
}

type SigningKey = Awaited<ReturnType<typeof importPKCS8>>;
type DeliveryKey = Awaited<ReturnType<typeof importSPKI>>;

export class AdminSessionDeliverySealer {
  private constructor(private readonly input: Readonly<{
    issuer: string;
    signingKeys: ReadonlyMap<string, SigningKey>;
    deliveryKeys: ReadonlyMap<string, DeliveryKey>;
    reference: () => string;
    clock: () => Date;
  }>) {}

  static async create(input: Readonly<{
    issuer: string;
    signingKeys: readonly Readonly<{ revision: string; privateKeyPem: string }>[];
    deliveryKeys: readonly Readonly<{ revision: string; publicKeyPem: string }>[];
    reference?: () => string;
    clock?: () => Date;
  }>): Promise<AdminSessionDeliverySealer> {
    const issuer = new URL(input.issuer);
    if (issuer.protocol !== "https:" || issuer.username || issuer.password || issuer.hash) {
      throw new Error("ADMIN_DELIVERY_ISSUER_INVALID");
    }
    if (
      input.signingKeys.length < 1 || input.signingKeys.length > 8 ||
      input.deliveryKeys.length < 1 || input.deliveryKeys.length > 32
    ) throw new Error("ADMIN_DELIVERY_KEY_RING_INVALID");
    const signingKeys = new Map<string, SigningKey>();
    for (const item of input.signingKeys) {
      keyRevision(item.revision);
      if (signingKeys.has(item.revision)) throw new Error("ADMIN_DELIVERY_KEY_DUPLICATE");
      const key = createPrivateKey(item.privateKeyPem);
      if (
        key.asymmetricKeyType !== "ec" ||
        key.asymmetricKeyDetails?.namedCurve !== "prime256v1"
      ) throw new Error("ADMIN_DELIVERY_SIGNING_KEY_INVALID");
      signingKeys.set(item.revision, await importPKCS8(item.privateKeyPem, "ES256"));
    }
    const deliveryKeys = new Map<string, DeliveryKey>();
    for (const item of input.deliveryKeys) {
      keyRevision(item.revision);
      if (deliveryKeys.has(item.revision)) throw new Error("ADMIN_DELIVERY_KEY_DUPLICATE");
      const key = createPublicKey(item.publicKeyPem);
      if (key.asymmetricKeyType !== "rsa") throw new Error("ADMIN_DELIVERY_RSA_KEY_INVALID");
      if ((key.asymmetricKeyDetails?.modulusLength ?? 0) < 3072) {
        throw new Error("ADMIN_DELIVERY_RSA_KEY_TOO_SMALL");
      }
      deliveryKeys.set(item.revision, await importSPKI(item.publicKeyPem, "RSA-OAEP-256"));
    }
    return new AdminSessionDeliverySealer(Object.freeze({
      issuer: issuer.href.replace(/\/$/u, ""),
      signingKeys,
      deliveryKeys,
      reference: input.reference ?? (() => crypto.randomUUID()),
      clock: input.clock ?? (() => new Date()),
    }));
  }

  async seal(input: Readonly<{
    sessionRef: string;
    opaqueCredential: string;
    sessionExpiresAt: string;
    deliveryExpiresAt: string;
    transaction: AdminOidcTransaction;
    operator: AdminOidcOperatorAuthority;
    claims: AdminOidcProviderClaims;
  }>): Promise<string> {
    const signingKey = this.input.signingKeys.get(input.transaction.signingKeyRevision);
    const deliveryKey = this.input.deliveryKeys.get(input.transaction.deliveryKeyRevision);
    if (signingKey === undefined || deliveryKey === undefined) {
      throw new Error("ADMIN_DELIVERY_FROZEN_KEY_UNAVAILABLE");
    }
    if (
      input.transaction.exchangeRequestDigest === undefined ||
      !/^[a-f0-9]{64}$/u.test(input.transaction.exchangeRequestDigest)
    ) throw new Error("ADMIN_DELIVERY_EXCHANGE_DIGEST_INVALID");
    const now = this.input.clock();
    const issuedAt = Math.floor(now.getTime() / 1000);
    const expiresAt = Math.floor(Date.parse(input.deliveryExpiresAt) / 1000);
    if (
      !Number.isFinite(expiresAt) || expiresAt <= issuedAt || expiresAt - issuedAt > 5 * 60 ||
      Date.parse(input.sessionExpiresAt) <= Date.parse(input.deliveryExpiresAt)
    ) throw new Error("ADMIN_DELIVERY_EXPIRY_INVALID");
    const sessionEpoch = 1n;
    const attestation = operatorAttestation({
      sessionRef: input.sessionRef,
      sessionEpoch,
      operator: input.operator,
      transaction: input.transaction,
    });
    const signed = await new SignJWT({
      workload_identity_ref: input.transaction.axes.workloadIdentityRef,
      environment: input.transaction.axes.environment,
      region: input.transaction.axes.region,
      managed_device_ref: input.transaction.axes.managedDeviceRef,
      transaction_ref: input.transaction.transactionRef,
      exchange_request_digest: input.transaction.exchangeRequestDigest,
      operator_ref: input.operator.operatorRef,
      operator_generation: input.operator.operatorGeneration.toString(),
      operator_session_ref: input.sessionRef,
      opaque_session_credential: input.opaqueCredential,
      session_expires_at: input.sessionExpiresAt,
      operator_security_epoch: input.operator.operatorSecurityEpoch.toString(),
      session_epoch: sessionEpoch.toString(),
      restriction_epoch: input.operator.restrictionEpoch.toString(),
      policy_epoch: input.operator.policyEpoch.toString(),
      assurance_level: input.claims.assuranceLevel,
      factor_classes: [...input.claims.factorClasses],
      authenticated_at: input.claims.authenticationTime,
      step_up_at: null,
      operator_attestation_ref: attestation.ref,
      operator_attestation_digest: attestation.digest,
      authority: authorityClaims(input.operator),
    })
      .setProtectedHeader({
        alg: "ES256",
        typ: "kokoro-admin-session-delivery+jwt",
        kid: input.transaction.signingKeyRevision,
      })
      .setIssuer(this.input.issuer)
      .setAudience(input.transaction.axes.workloadIdentityRef)
      .setJti(this.input.reference())
      .setIssuedAt(issuedAt)
      .setNotBefore(issuedAt)
      .setExpirationTime(expiresAt)
      .sign(signingKey);
    return new CompactEncrypt(Buffer.from(signed, "utf8"))
      .setProtectedHeader({
        alg: "RSA-OAEP-256",
        enc: "A256GCM",
        typ: "kokoro-admin-session-delivery+jwe",
        cty: "JWT",
        kid: input.transaction.deliveryKeyRevision,
      })
      .encrypt(deliveryKey);
  }
}

function authorityClaims(operator: AdminOidcOperatorAuthority): Readonly<Record<string, unknown>> {
  return Object.freeze({
    permissions: [...operator.permissions],
    expires_at: operator.expiresAt,
    site_scopes: operator.siteScopes.map((scope) => ({
      site_id: scope.siteRef,
      environment: scope.environment,
      region: scope.region,
      scope_epoch: scope.scopeEpoch.toString(),
      expires_at: scope.expiresAt,
    })),
    global_scopes: operator.globalScopes.map((scope) => ({
      grant_id: scope.grantRef,
      environment: scope.environment,
      region: scope.region,
      scope_epoch: scope.scopeEpoch.toString(),
      expires_at: scope.expiresAt,
    })),
    break_glass_scopes: operator.breakGlassScopes.map((scope) => ({
      grant_id: scope.grantRef,
      incident_id: scope.incidentRef,
      environment: scope.environment,
      region: scope.region,
      authorized_operation: scope.authorizedOperation,
      resource_refs: [...scope.resourceRefs],
      field_allowlist: [...scope.fieldAllowlist],
      scope_epoch: scope.scopeEpoch.toString(),
      expires_at: scope.expiresAt,
    })),
  });
}

function operatorAttestation(input: Readonly<{
  sessionRef: string;
  sessionEpoch: bigint;
  operator: AdminOidcOperatorAuthority;
  transaction: AdminOidcTransaction;
}>): Readonly<{ ref: string; digest: string }> {
  const ref = `admin-session:${input.sessionRef}:${input.sessionEpoch.toString()}`;
  const digest = createHash("sha256").update("kokoro.admin-operator-attestation.v1")
    .update("\0").update(JSON.stringify({
      ref,
      operatorRef: input.operator.operatorRef,
      operatorGeneration: input.operator.operatorGeneration.toString(),
      operatorSecurityEpoch: input.operator.operatorSecurityEpoch.toString(),
      restrictionEpoch: input.operator.restrictionEpoch.toString(),
      policyEpoch: input.operator.policyEpoch.toString(),
      workloadIdentityRef: input.transaction.axes.workloadIdentityRef,
      environment: input.transaction.axes.environment,
      region: input.transaction.axes.region,
      managedDeviceRef: input.transaction.axes.managedDeviceRef,
      audience: input.transaction.axes.audience,
    })).digest("hex");
  return Object.freeze({ ref, digest });
}

function canonicalBase64Url(value: string, exactBytes?: number): Buffer {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error("invalid base64url");
  const decoded = Buffer.from(value, "base64url");
  if (decoded.toString("base64url") !== value ||
      (exactBytes !== undefined && decoded.byteLength !== exactBytes)) {
    throw new Error("invalid base64url");
  }
  return decoded;
}

function keyRevision(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/u.test(value)) {
    throw new Error("ADMIN_DELIVERY_KEY_REVISION_INVALID");
  }
}
