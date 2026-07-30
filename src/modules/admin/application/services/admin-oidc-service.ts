import { timingSafeEqual } from "node:crypto";

export interface AdminWorkloadAxes {
  readonly workloadIdentityRef: string;
  readonly environment: string;
  readonly region: string;
  readonly managedDeviceRef: string;
  readonly audience: string;
}

export interface AdminOidcRegistration {
  readonly issuer: string;
  readonly clientId: string;
  readonly oidcAudience: string;
  readonly exactCallbackUri: string;
  readonly returnIntentRefs: readonly string[];
  readonly signingKeyRevision: string;
  readonly deliveryKeyRevision: string;
}

export type AdminOidcTransactionState =
  | "pending" | "redeeming" | "committed" | "provider_outcome_unknown" | "rejected";

export interface AdminOidcTransaction {
  transactionRef: string;
  state: AdminOidcTransactionState;
  beginCommandId: string;
  beginIdempotencyKey: string;
  beginRequestDigest: string;
  axes: AdminWorkloadAxes;
  returnIntentRef: string;
  issuer: string;
  clientId: string;
  oidcAudience: string;
  exactCallbackUri: string;
  pkceVerifierCiphertext: string;
  pkceChallenge: string;
  nonceCiphertext: string;
  stateDigest: string;
  recoveryDigest: string;
  signingKeyRevision: string;
  deliveryKeyRevision: string;
  expiresAt: string;
  recoveryExpiresAt: string;
  exchangeCommandId?: string;
  exchangeIdempotencyKey?: string;
  exchangeRequestDigest?: string;
  sessionRef?: string;
  sessionExpiresAt?: string;
  deliveryExpiresAt?: string;
  deliveryEnvelope?: string;
  exchangeReceipt?: AdminOidcReceipt;
}

export interface AdminOidcReceipt {
  readonly commandId: string;
  readonly idempotencyKey: string;
  readonly requestDigest: string;
  readonly operation: "admin.identity.begin" | "admin.identity.exchange";
  readonly state: "committed";
  readonly recordedAt: string;
}

export interface AdminOidcStore {
  create(transaction: AdminOidcTransaction): Promise<AdminOidcTransaction>;
  find(transactionRef: string, axes: AdminWorkloadAxes): Promise<AdminOidcTransaction | null>;
  claimExchange(
    transactionRef: string,
    request: Readonly<{ commandId: string; idempotencyKey: string; requestDigest: string }>,
    axes: AdminWorkloadAxes,
  ): Promise<AdminOidcTransaction | null>;
  markProviderOutcomeUnknown(transactionRef: string, axes: AdminWorkloadAxes): Promise<void>;
  markRejected(transactionRef: string, axes: AdminWorkloadAxes): Promise<void>;
  commitExchange(
    transactionRef: string,
    commit: Readonly<{
      sessionRef: string;
      sessionExpiresAt: string;
      deliveryExpiresAt: string;
      deliveryEnvelope: string;
      exchangeReceipt: AdminOidcReceipt;
      credentialDigest: string;
      operatorRef: string;
      operatorGeneration: bigint;
      operatorSecurityEpoch: bigint;
      restrictionEpoch: bigint;
      policyEpoch: bigint;
      assuranceLevel: "password" | "mfa" | "phishing_resistant";
      factorClasses: readonly string[];
      authenticatedAt: string;
    }>,
    axes: AdminWorkloadAxes,
  ): Promise<AdminOidcTransaction>;
}

export interface AdminOidcProviderClaims {
  readonly issuer: string;
  readonly subject: string;
  readonly audience: string;
  readonly nonce: string;
  readonly authenticationTime: string;
  readonly assuranceLevel: "password" | "mfa" | "phishing_resistant";
  readonly factorClasses: readonly string[];
  readonly managedDeviceRef: string;
}

export interface AdminOidcDelivery {
  readonly operatorSessionRef: string;
  readonly deliveryEnvelope: string;
  readonly sessionExpiresAt: string;
  readonly deliveryExpiresAt: string;
  readonly receipt: AdminOidcReceipt;
}

export class OidcProviderOutcomeUnknownError extends Error {
  constructor() {
    super("OIDC_PROVIDER_OUTCOME_UNKNOWN");
    this.name = "OidcProviderOutcomeUnknownError";
  }
}

export class AdminOidcService {
  constructor(private readonly dependencies: Readonly<{
    store: AdminOidcStore;
    provider: Readonly<{
      authorizationUri(input: Readonly<{
        registration: AdminOidcRegistration;
        codeChallenge: string;
        nonce: string;
        state: string;
      }>): string;
      redeem(input: Readonly<{
        registration: AdminOidcRegistration;
        authorizationCode: string;
        pkceVerifier: string;
        expectedNonce: string;
        expectedState: string;
      }>): Promise<AdminOidcProviderClaims>;
    }>;
    registration: Readonly<{ resolve(axes: AdminWorkloadAxes): AdminOidcRegistration }>;
    protector: Readonly<{ seal(value: string): string; open(value: string): string }>;
    recoveryDigester(value: Uint8Array): string;
    operator: Readonly<{
      resolve(claims: AdminOidcProviderClaims, axes: AdminWorkloadAxes): Promise<Readonly<{
        operatorRef: string;
        operatorGeneration: bigint;
        operatorSecurityEpoch: bigint;
        restrictionEpoch: bigint;
        policyEpoch: bigint;
      }> | null>;
    }>;
    delivery: Readonly<{
      seal(input: Readonly<{
        sessionRef: string;
        opaqueCredential: string;
        sessionExpiresAt: string;
        deliveryExpiresAt: string;
        transaction: AdminOidcTransaction;
        operatorRef: string;
        operatorGeneration: bigint;
        claims: AdminOidcProviderClaims;
      }>): Promise<string>;
    }>;
    references(): string;
    credential(): string;
    secrets(): Readonly<{ verifier: string; challenge: string; nonce: string }>;
    credentialDigester(value: string): string;
    clock(): Date;
  }>) {}

  async begin(input: Readonly<{
    commandId: string;
    idempotencyKey: string;
    requestDigest: string;
    axes: AdminWorkloadAxes;
    returnIntentRef: string;
    recoveryHandle: Uint8Array;
  }>): Promise<Readonly<{
    transactionRef: string;
    authorizationUri: string;
    expiresAt: string;
    recoveryExpiresAt: string;
    receipt: AdminOidcReceipt;
  }>> {
    command(input.commandId, input.idempotencyKey, input.requestDigest);
    axes(input.axes);
    recovery(input.recoveryHandle);
    const registration = this.dependencies.registration.resolve(input.axes);
    validateRegistration(registration, input.returnIntentRef);
    const secret = this.dependencies.secrets();
    validateSecrets(secret);
    const now = this.dependencies.clock();
    const expiresAt = new Date(now.getTime() + 5 * 60_000).toISOString();
    const recoveryExpiresAt = new Date(now.getTime() + 10 * 60_000).toISOString();
    const transactionRef = this.dependencies.references();
    const receipt: AdminOidcReceipt = Object.freeze({
      commandId: input.commandId,
      idempotencyKey: input.idempotencyKey,
      requestDigest: input.requestDigest,
      operation: "admin.identity.begin",
      state: "committed",
      recordedAt: now.toISOString(),
    });
    const stored = await this.dependencies.store.create({
      transactionRef,
      state: "pending",
      beginCommandId: input.commandId,
      beginIdempotencyKey: input.idempotencyKey,
      beginRequestDigest: input.requestDigest,
      axes: Object.freeze({ ...input.axes }),
      returnIntentRef: input.returnIntentRef,
      issuer: registration.issuer,
      clientId: registration.clientId,
      oidcAudience: registration.oidcAudience,
      exactCallbackUri: registration.exactCallbackUri,
      pkceVerifierCiphertext: this.dependencies.protector.seal(secret.verifier),
      pkceChallenge: secret.challenge,
      nonceCiphertext: this.dependencies.protector.seal(secret.nonce),
      stateDigest: this.dependencies.recoveryDigester(Buffer.from(transactionRef, "utf8")),
      recoveryDigest: this.dependencies.recoveryDigester(input.recoveryHandle),
      signingKeyRevision: registration.signingKeyRevision,
      deliveryKeyRevision: registration.deliveryKeyRevision,
      expiresAt,
      recoveryExpiresAt,
    });
    if (
      stored.beginCommandId !== input.commandId || stored.beginIdempotencyKey !== input.idempotencyKey ||
      stored.beginRequestDigest !== input.requestDigest ||
      !safeEqual(stored.recoveryDigest, this.dependencies.recoveryDigester(input.recoveryHandle))
    ) throw new Error("ADMIN_OIDC_BEGIN_CONFLICT");
    const authorizationUri = this.dependencies.provider.authorizationUri({
      registration: transactionRegistration(stored),
      codeChallenge: stored.pkceChallenge,
      nonce: this.dependencies.protector.open(stored.nonceCiphertext),
      state: stored.transactionRef,
    });
    if (!/^https:\/\//u.test(authorizationUri) || authorizationUri.length > 2048) {
      throw new Error("ADMIN_OIDC_AUTHORIZATION_URI_INVALID");
    }
    return Object.freeze({ transactionRef: stored.transactionRef, authorizationUri,
      expiresAt: stored.expiresAt, recoveryExpiresAt: stored.recoveryExpiresAt, receipt });
  }

  async exchange(input: Readonly<{
    commandId: string;
    idempotencyKey: string;
    requestDigest: string;
    axes: AdminWorkloadAxes;
    transactionRef: string;
    authorizationCode: string;
    recoveryHandle: Uint8Array;
  }>): Promise<AdminOidcDelivery> {
    command(input.commandId, input.idempotencyKey, input.requestDigest);
    axes(input.axes);
    recovery(input.recoveryHandle);
    const current = await this.dependencies.store.find(input.transactionRef, input.axes);
    this.requireTransaction(current, input.axes, input.recoveryHandle);
    if (current.state === "committed") return this.restore(current, input);
    if (current.state === "provider_outcome_unknown" || current.state === "redeeming") {
      throw new Error("ADMIN_OIDC_RESTART_LOGIN_REQUIRED");
    }
    if (current.state !== "pending" || Date.parse(current.expiresAt) <= this.dependencies.clock().getTime()) {
      throw new Error("ADMIN_OIDC_TRANSACTION_NOT_FOUND");
    }
    if (input.authorizationCode.length < 1 || input.authorizationCode.length > 2048) {
      throw new Error("ADMIN_OIDC_CODE_INVALID");
    }
    const claimed = await this.dependencies.store.claimExchange(input.transactionRef, input, input.axes);
    if (claimed === null) throw new Error("ADMIN_OIDC_TRANSACTION_NOT_FOUND");
    if (claimed.state === "committed") return this.restore(claimed, input);
    if (claimed.state !== "redeeming") throw new Error("ADMIN_OIDC_RESTART_LOGIN_REQUIRED");
    const registration = transactionRegistration(claimed);
    let claims: AdminOidcProviderClaims;
    try {
      claims = await this.dependencies.provider.redeem({
        registration,
        authorizationCode: input.authorizationCode,
        pkceVerifier: this.dependencies.protector.open(claimed.pkceVerifierCiphertext),
        expectedNonce: this.dependencies.protector.open(claimed.nonceCiphertext),
        expectedState: claimed.transactionRef,
      });
    } catch (error) {
      if (error instanceof OidcProviderOutcomeUnknownError) {
        await this.dependencies.store.markProviderOutcomeUnknown(input.transactionRef, input.axes);
        throw new Error("ADMIN_OIDC_RESTART_LOGIN_REQUIRED");
      }
      await this.dependencies.store.markRejected(input.transactionRef, input.axes);
      throw new Error("ADMIN_OIDC_LOGIN_REJECTED");
    }
    try {
      verifyClaims(
        claimed,
        claims,
        this.dependencies.protector.open(claimed.nonceCiphertext),
        this.dependencies.clock(),
      );
    } catch {
      await this.dependencies.store.markRejected(input.transactionRef, input.axes);
      throw new Error("ADMIN_OIDC_LOGIN_REJECTED");
    }
    const operator = await this.dependencies.operator.resolve(claims, claimed.axes);
    if (operator === null) {
      await this.dependencies.store.markRejected(input.transactionRef, input.axes);
      throw new Error("ADMIN_OIDC_LOGIN_REJECTED");
    }
    const now = this.dependencies.clock();
    const sessionRef = this.dependencies.references();
    const opaqueCredential = this.dependencies.credential();
    if (Buffer.byteLength(opaqueCredential, "utf8") < 32 ||
        Buffer.byteLength(opaqueCredential, "utf8") > 512 || /\s/u.test(opaqueCredential)) {
      throw new Error("ADMIN_SESSION_CREDENTIAL_INVALID");
    }
    const sessionExpiresAt = new Date(now.getTime() + 15 * 60_000).toISOString();
    const deliveryExpiresAt = new Date(now.getTime() + 2 * 60_000).toISOString();
    const exchangeReceipt: AdminOidcReceipt = Object.freeze({
      commandId: input.commandId,
      idempotencyKey: input.idempotencyKey,
      requestDigest: input.requestDigest,
      operation: "admin.identity.exchange",
      state: "committed",
      recordedAt: now.toISOString(),
    });
    const deliveryEnvelope = await this.dependencies.delivery.seal({
      sessionRef,
      opaqueCredential,
      sessionExpiresAt,
      deliveryExpiresAt,
      transaction: claimed,
      operatorRef: operator.operatorRef,
      operatorGeneration: operator.operatorGeneration,
      claims,
    });
    const committed = await this.dependencies.store.commitExchange(input.transactionRef, {
      sessionRef,
      sessionExpiresAt,
      deliveryExpiresAt,
      deliveryEnvelope,
      exchangeReceipt,
      credentialDigest: this.dependencies.credentialDigester(opaqueCredential),
      operatorRef: operator.operatorRef,
      operatorGeneration: operator.operatorGeneration,
      operatorSecurityEpoch: operator.operatorSecurityEpoch,
      restrictionEpoch: operator.restrictionEpoch,
      policyEpoch: operator.policyEpoch,
      assuranceLevel: claims.assuranceLevel,
      factorClasses: claims.factorClasses,
      authenticatedAt: claims.authenticationTime,
    }, input.axes);
    return this.delivery(committed);
  }

  async getDelivery(input: Readonly<{
    requestId: string;
    axes: AdminWorkloadAxes;
    transactionRef: string;
    recoveryHandle: Uint8Array;
  }>): Promise<AdminOidcDelivery> {
    if (input.requestId.length < 1 || input.requestId.length > 128) {
      throw new Error("ADMIN_SESSION_DELIVERY_NOT_FOUND");
    }
    const transaction = await this.dependencies.store.find(input.transactionRef, input.axes);
    try {
      this.requireTransaction(transaction, input.axes, input.recoveryHandle);
    } catch {
      throw new Error("ADMIN_SESSION_DELIVERY_NOT_FOUND");
    }
    if (
      transaction.state !== "committed" || transaction.deliveryExpiresAt === undefined ||
      Date.parse(transaction.deliveryExpiresAt) <= this.dependencies.clock().getTime()
    ) throw new Error("ADMIN_SESSION_DELIVERY_NOT_FOUND");
    return this.delivery(transaction);
  }

  private requireTransaction(
    transaction: AdminOidcTransaction | null,
    expectedAxes: AdminWorkloadAxes,
    recoveryHandle: Uint8Array,
  ): asserts transaction is AdminOidcTransaction {
    if (
      transaction === null || !sameAxes(transaction.axes, expectedAxes) ||
      !safeEqual(transaction.recoveryDigest, this.dependencies.recoveryDigester(recoveryHandle)) ||
      Date.parse(transaction.recoveryExpiresAt) <= this.dependencies.clock().getTime()
    ) throw new Error("ADMIN_OIDC_TRANSACTION_NOT_FOUND");
  }

  private restore(
    transaction: AdminOidcTransaction,
    input: Readonly<{ commandId: string; idempotencyKey: string; requestDigest: string }>,
  ): AdminOidcDelivery {
    if (
      transaction.exchangeCommandId !== input.commandId ||
      transaction.exchangeIdempotencyKey !== input.idempotencyKey ||
      transaction.exchangeRequestDigest !== input.requestDigest
    ) throw new Error("ADMIN_OIDC_EXCHANGE_CONFLICT");
    return this.delivery(transaction);
  }

  private delivery(transaction: AdminOidcTransaction): AdminOidcDelivery {
    if (
      transaction.sessionRef === undefined || transaction.sessionExpiresAt === undefined ||
      transaction.deliveryExpiresAt === undefined || transaction.deliveryEnvelope === undefined ||
      transaction.exchangeReceipt === undefined
    ) throw new Error("ADMIN_SESSION_DELIVERY_CORRUPT");
    return Object.freeze({
      operatorSessionRef: transaction.sessionRef,
      deliveryEnvelope: transaction.deliveryEnvelope,
      sessionExpiresAt: transaction.sessionExpiresAt,
      deliveryExpiresAt: transaction.deliveryExpiresAt,
      receipt: transaction.exchangeReceipt,
    });
  }
}

function command(commandId: string, idempotencyKey: string, digest: string): void {
  if (
    commandId.length < 3 || commandId.length > 128 ||
    idempotencyKey.length < 3 || idempotencyKey.length > 128 ||
    !/^[a-f0-9]{64}$/u.test(digest)
  ) throw new Error("ADMIN_OIDC_COMMAND_INVALID");
}

function axes(value: AdminWorkloadAxes): void {
  if (
    !value.workloadIdentityRef.startsWith("spiffe://") ||
    [value.environment, value.region, value.managedDeviceRef, value.audience]
      .some((field) => field.length < 1 || field.length > 256)
  ) throw new Error("ADMIN_WORKLOAD_AXES_INVALID");
}

function recovery(value: Uint8Array): void {
  if (!(value instanceof Uint8Array) || value.byteLength !== 32) {
    throw new Error("ADMIN_SESSION_RECOVERY_PROOF_INVALID");
  }
}

function validateRegistration(value: AdminOidcRegistration, returnIntentRef: string): void {
  for (const url of [value.issuer, value.exactCallbackUri]) {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash) {
      throw new Error("ADMIN_OIDC_REGISTRATION_INVALID");
    }
  }
  if (
    !value.returnIntentRefs.includes(returnIntentRef) || value.clientId.length < 1 ||
    value.oidcAudience.length < 1 || value.signingKeyRevision.length < 1 ||
    value.deliveryKeyRevision.length < 1
  ) throw new Error("ADMIN_OIDC_REGISTRATION_INVALID");
}

function validateSecrets(value: Readonly<{
  verifier: string;
  challenge: string;
  nonce: string;
}>): void {
  if ([value.verifier, value.challenge, value.nonce].some((item) => item.length < 8)) {
    throw new Error("ADMIN_OIDC_SECRET_GENERATION_INVALID");
  }
}

function transactionRegistration(value: AdminOidcTransaction): AdminOidcRegistration {
  return Object.freeze({
    issuer: value.issuer,
    clientId: value.clientId,
    oidcAudience: value.oidcAudience,
    exactCallbackUri: value.exactCallbackUri,
    returnIntentRefs: [value.returnIntentRef],
    signingKeyRevision: value.signingKeyRevision,
    deliveryKeyRevision: value.deliveryKeyRevision,
  });
}

function verifyClaims(
  transaction: AdminOidcTransaction,
  claims: AdminOidcProviderClaims,
  expectedNonce: string,
  now: Date,
): void {
  const authenticationTime = Date.parse(claims.authenticationTime);
  if (
    claims.issuer !== transaction.issuer || claims.audience !== transaction.oidcAudience ||
    claims.nonce !== expectedNonce ||
    claims.managedDeviceRef !== transaction.axes.managedDeviceRef || claims.subject.length < 1 ||
    claims.assuranceLevel !== "phishing_resistant" || !claims.factorClasses.includes("webauthn") ||
    !Number.isFinite(authenticationTime) || authenticationTime < now.getTime() - 5 * 60_000 ||
    authenticationTime > now.getTime() + 60_000 || claims.factorClasses.length < 1 ||
    new Set(claims.factorClasses).size !== claims.factorClasses.length
  ) throw new Error("ADMIN_OIDC_CLAIMS_INVALID");
}

function sameAxes(left: AdminWorkloadAxes, right: AdminWorkloadAxes): boolean {
  return left.workloadIdentityRef === right.workloadIdentityRef &&
    left.environment === right.environment && left.region === right.region &&
    left.managedDeviceRef === right.managedDeviceRef && left.audience === right.audience;
}

function safeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return leftBytes.byteLength === rightBytes.byteLength && timingSafeEqual(leftBytes, rightBytes);
}
