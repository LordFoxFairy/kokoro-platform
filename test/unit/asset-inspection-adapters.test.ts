import { describe, expect, it, vi } from "vitest";
import { parseAssetInspectionPolicyRegistry } from
  "../../src/modules/asset/infrastructure/config/asset-inspection-policy-registry.js";
import { assetScanCommandDigest, HttpsAssetSecurityScanner } from
  "../../src/modules/asset/infrastructure/http/asset-security-scanner.js";

describe("Asset inspection production adapters", () => {
  it("resolves only an exact Site, revision and purpose policy", async () => {
    const registry = parseAssetInspectionPolicyRegistry({ version: 1, policies: [policy()] });
    await expect(registry.resolve({ siteRef: "site_01", policyRevisionRef: "policy_01",
      purpose: "chat-attachment" })).resolves.toMatchObject({ scannerDefinitionRef: "scanner_01",
      allowedDetectedMediaTypes: ["image/png"] });
    await expect(registry.resolve({ siteRef: "site_02", policyRevisionRef: "policy_01",
      purpose: "chat-attachment" })).rejects.toThrow("ASSET_INSPECTION_POLICY_NOT_CONFIGURED");
  });

  it("rejects duplicate, unknown-field and non-canonical policy registries", () => {
    expect(() => parseAssetInspectionPolicyRegistry({ version: 1,
      policies: [policy(), policy()] })).toThrow("ASSET_INSPECTION_POLICY_REGISTRY_INVALID");
    expect(() => parseAssetInspectionPolicyRegistry({ version: 1,
      policies: [{ ...policy(), fallback: true }] })).toThrow("ASSET_INSPECTION_POLICY_REGISTRY_INVALID");
    expect(() => parseAssetInspectionPolicyRegistry({ version: 1,
      policies: [{ ...policy(), allowedDetectedMediaTypes: ["Image/PNG"] }] }))
      .toThrow("ASSET_INSPECTION_POLICY_REGISTRY_INVALID");
  });

  it("sends one authenticated immutable command and accepts only bound scanner evidence", async () => {
    const command = scanInput();
    const calls: Array<{ url: URL; headers: Readonly<Record<string, string>>; body: Uint8Array }> = [];
    const scanner = createScanner(async ({ url, headers, body }) => {
      calls.push({ url, headers, body });
      return response(command);
    });

    await expect(scanner.inspect(command)).resolves.toMatchObject({
      scannerDefinitionRef: "scanner_01", malwareDisposition: "clean", detectedMediaType: "image/png",
    });
    expect(calls[0]?.url.href).toBe("https://scanner.internal.example/v1/assets/inspect");
    expect(calls[0]?.headers.authorization).toBe("Bearer scanner-token-0123456789");
    expect(calls[0]?.headers["idempotency-key"]).toBe(assetScanCommandDigest(command));
    expect(JSON.parse(new TextDecoder().decode(calls[0]?.body)) as unknown).toMatchObject({
      providerVersionRef: "provider-version-01", maximumBytes: "1048576",
    });
  });

  it("rejects provider evidence for a different immutable object version", async () => {
    const command = scanInput();
    const scanner = createScanner(async () => {
      const value = JSON.parse(new TextDecoder().decode(response(command).body)) as Record<string, unknown>;
      return jsonResponse({ ...value, providerVersionRef: "provider-version-wrong" });
    });
    await expect(scanner.inspect(command)).rejects.toMatchObject({
      code: "ASSET_SCANNER_RESPONSE_BINDING_MISMATCH", retryable: true,
    });
  });

  it("bounds a hung scanner request and rejects oversized adapter responses", async () => {
    vi.useFakeTimers();
    try {
      const timedOut = createScanner(async ({ signal }) => new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }), 100);
      const request = timedOut.inspect(scanInput());
      const expectation = expect(request).rejects.toMatchObject({ code: "ASSET_SCANNER_TIMEOUT", retryable: true });
      await vi.advanceTimersByTimeAsync(100);
      await expectation;
    } finally {
      vi.useRealTimers();
    }
    const oversized = createScanner(async () => ({ status: 200, contentType: "application/json",
      body: new Uint8Array(256 * 1024 + 1) }));
    await expect(oversized.inspect(scanInput())).rejects.toMatchObject({
      code: "ASSET_SCANNER_RESPONSE_TOO_LARGE", retryable: true,
    });
  });

  it("rejects request-derived, insecure and ambiguous scanner endpoints", () => {
    for (const endpoint of ["http://scanner.internal.example/v1/assets/inspect",
      "https://127.0.0.1/v1/assets/inspect", "https://scanner.internal.example/other",
      "https://scanner.internal.example/v1/assets/inspect?target=http://metadata"]) {
      expect(() => createScanner(async () => response(scanInput()), 1_000, endpoint))
        .toThrow("ASSET_SCANNER_ENDPOINT_INVALID");
    }
  });
});

function createScanner(
  transport: NonNullable<ConstructorParameters<typeof HttpsAssetSecurityScanner>[0]["transport"]>,
  timeoutMs = 1_000,
  endpoint = "https://scanner.internal.example/v1/assets/inspect",
) {
  return new HttpsAssetSecurityScanner({ endpoint, audience: "platform-asset-worker",
    bearerToken: "scanner-token-0123456789", timeoutMs,
    tls: { ca: "-----BEGIN CERTIFICATE-----\nCA", cert: "-----BEGIN CERTIFICATE-----\nCLIENT",
      key: "-----BEGIN PRIVATE KEY-----\nKEY" }, transport });
}

function response(command: ReturnType<typeof scanInput>) {
  return jsonResponse({ commandDigest: assetScanCommandDigest(command),
    storageTenantRef: command.storageTenantRef, storageRegion: command.storageRegion,
    quarantineObjectRef: command.quarantineObjectRef, providerVersionRef: command.providerVersionRef,
    expectedChecksumSha256: command.expectedChecksumSha256,
    scannerDefinitionRef: command.policy.scannerDefinitionRef,
    scannerRevisionRef: command.policy.scannerRevisionRef,
    signatureRevisionRef: command.policy.signatureRevisionRef,
    detectedMediaType: "image/png", magicSignatureRef: "png-signature-v1",
    containerSummaryDigest: "d".repeat(64), malwareDisposition: "clean",
    contentSafetyDisposition: "allow", evidenceRef: "scanner-evidence-01",
    evidenceDigest: "e".repeat(64), occurredAt: "2026-07-30T11:00:00.000Z" });
}

function jsonResponse(value: unknown) {
  return Object.freeze({ status: 200, contentType: "application/json",
    body: new TextEncoder().encode(JSON.stringify(value)) });
}

function policy() {
  return { siteRef: "site_01", policyRevisionRef: "policy_01", purpose: "chat-attachment",
    allowedDetectedMediaTypes: ["image/png"], scannerDefinitionRef: "scanner_01",
    scannerRevisionRef: "scanner_revision_01", signatureRevisionRef: "signature_revision_01",
    contentSafetyRequired: true } as const;
}

function scanInput() {
  return { storageTenantRef: "storage_tenant_01", storageRegion: "us-east-1",
    quarantineObjectRef: "quarantine/site_01/object_01", providerVersionRef: "provider-version-01",
    expectedChecksumSha256: "a".repeat(64), maximumBytes: 1_048_576n,
    policy: { policyRevisionRef: "policy_01", purpose: "chat-attachment",
      allowedDetectedMediaTypes: ["image/png"], scannerDefinitionRef: "scanner_01",
      scannerRevisionRef: "scanner_revision_01", signatureRevisionRef: "signature_revision_01",
      contentSafetyRequired: true } } as const;
}
