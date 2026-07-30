import { generateKeyPairSync, randomBytes } from "node:crypto";
import { compactDecrypt, compactVerify, importPKCS8, importSPKI } from "jose";
import { describe, expect, it } from "vitest";
import {
  AesGcmAdminOidcTransactionProtector,
  AdminSessionDeliverySealer,
} from "../../src/modules/admin/infrastructure/jose/admin-session-delivery.js";
import type { AdminOidcTransaction } from
  "../../src/modules/admin/application/services/admin-oidc-service.js";

describe("Admin session protected delivery", () => {
  it("protects OIDC transaction secrets with authenticated AES-256-GCM", () => {
    const protector = new AesGcmAdminOidcTransactionProtector(randomBytes(32));
    const sealed = protector.seal("pkce-secret-value");

    expect(sealed).not.toContain("pkce-secret-value");
    expect(protector.open(sealed)).toBe("pkce-secret-value");
    const replacement = sealed.endsWith("A") ? "B" : "A";
    expect(() => protector.open(`${sealed.slice(0, -1)}${replacement}`))
      .toThrow("ADMIN_OIDC_TRANSACTION_SECRET_INVALID");
  });

  it("emits only ES256 JWS inside RSA-OAEP-256/A256GCM JWE with exact claims", async () => {
    const signing = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const delivery = generateKeyPairSync("rsa", { modulusLength: 3072 });
    const signingPrivatePem = signing.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const signingPublicPem = signing.publicKey.export({ type: "spki", format: "pem" }).toString();
    const deliveryPublicPem = delivery.publicKey.export({ type: "spki", format: "pem" }).toString();
    const deliveryPrivatePem = delivery.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const sealer = await AdminSessionDeliverySealer.create({
      issuer: "https://platform.example.test",
      signingKeys: [{ revision: "signing-1", privateKeyPem: signingPrivatePem }],
      deliveryKeys: [{ revision: "delivery-1", publicKeyPem: deliveryPublicPem }],
      reference: () => "delivery:jti:1",
      clock: () => new Date("2026-07-29T15:00:00.000Z"),
    });

    const compact = await sealer.seal({
      sessionRef: "operator-session:1",
      opaqueCredential: "opaque-session-credential",
      sessionExpiresAt: "2026-07-29T15:15:00.000Z",
      deliveryExpiresAt: "2026-07-29T15:02:00.000Z",
      transaction: transaction(),
      operatorRef: "operator:1",
      operatorGeneration: 2n,
      claims: {
        issuer: "https://issuer.example.test",
        subject: "oidc-subject:1",
        audience: "admin-audience",
        nonce: "nonce-value",
        authenticationTime: "2026-07-29T14:59:00.000Z",
        assuranceLevel: "phishing_resistant",
        factorClasses: ["oidc", "webauthn"],
        managedDeviceRef: "device:managed:1",
      },
    });

    const decrypted = await compactDecrypt(
      compact,
      await importPKCS8(deliveryPrivatePem, "RSA-OAEP-256"),
    );
    expect(decrypted.protectedHeader).toEqual({
      alg: "RSA-OAEP-256",
      enc: "A256GCM",
      typ: "kokoro-admin-session-delivery+jwe",
      cty: "JWT",
      kid: "delivery-1",
    });
    const verified = await compactVerify(
      new TextDecoder().decode(decrypted.plaintext),
      await importSPKI(signingPublicPem, "ES256"),
    );
    expect(verified.protectedHeader).toEqual({
      alg: "ES256",
      typ: "kokoro-admin-session-delivery+jwt",
      kid: "signing-1",
    });
    expect(JSON.parse(new TextDecoder().decode(verified.payload))).toMatchObject({
      iss: "https://platform.example.test",
      aud: "spiffe://kokoro/web/admin",
      jti: "delivery:jti:1",
      workload_identity_ref: "spiffe://kokoro/web/admin",
      environment: "production",
      region: "us-east-1",
      managed_device_ref: "device:managed:1",
      transaction_ref: "oidc-transaction:1",
      exchange_request_digest: "c".repeat(64),
      operator_session_ref: "operator-session:1",
      opaque_session_credential: "opaque-session-credential",
      session_expires_at: "2026-07-29T15:15:00.000Z",
    });
  });

  it("rejects a delivery key smaller than RSA-3072", async () => {
    const signing = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const weakDelivery = generateKeyPairSync("rsa", { modulusLength: 2048 });
    await expect(AdminSessionDeliverySealer.create({
      issuer: "https://platform.example.test",
      signingKeys: [{
        revision: "signing-1",
        privateKeyPem: signing.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      }],
      deliveryKeys: [{
        revision: "delivery-1",
        publicKeyPem: weakDelivery.publicKey.export({ type: "spki", format: "pem" }).toString(),
      }],
    })).rejects.toThrow("ADMIN_DELIVERY_RSA_KEY_TOO_SMALL");
  });
});

function transaction(): AdminOidcTransaction {
  return {
    transactionRef: "oidc-transaction:1",
    state: "redeeming",
    beginCommandId: "command:begin:1",
    beginIdempotencyKey: "begin-key-1",
    beginRequestDigest: "a".repeat(64),
    exchangeCommandId: "command:exchange:1",
    exchangeIdempotencyKey: "exchange-key-1",
    exchangeRequestDigest: "c".repeat(64),
    axes: {
      workloadIdentityRef: "spiffe://kokoro/web/admin",
      environment: "production",
      region: "us-east-1",
      managedDeviceRef: "device:managed:1",
      audience: "platform-admin",
    },
    returnIntentRef: "dashboard",
    issuer: "https://issuer.example.test",
    clientId: "admin-client",
    oidcAudience: "admin-audience",
    exactCallbackUri: "https://admin.example.test/auth/callback",
    pkceVerifierCiphertext: "protected",
    pkceChallenge: "challenge-0001",
    nonceCiphertext: "protected",
    stateDigest: "d".repeat(64),
    recoveryDigest: "e".repeat(64),
    signingKeyRevision: "signing-1",
    deliveryKeyRevision: "delivery-1",
    expiresAt: "2026-07-29T15:05:00.000Z",
    recoveryExpiresAt: "2026-07-29T15:10:00.000Z",
  };
}
