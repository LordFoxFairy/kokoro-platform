import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { createAssetDataPlaneHttpHandler } from
  "../../src/interfaces/http/asset-data-plane.js";
import type {
  AuthorizedAssetMultipartSnapshot,
  StoredAssetMultipartPart,
  StoredAssetMultipartUpload,
} from "../../src/modules/asset/application/contracts/asset-multipart-ports.js";
import type { AssetUploadCapabilityClaims } from
  "../../src/modules/asset/application/contracts/asset-upload-ports.js";

const NOW = "2026-07-29T12:00:00.000Z";
const ORIGIN = "https://chat.example.test";
const AUDIENCE = "asset-upload-production";
const UPLOAD_REF = "multipart_upload_0001";
const REQUEST_ID = "0198f758-2534-7bbb-8bbb-0123456789ab";

describe("Asset data-plane HTTP", () => {
  it("answers an exact preflight without verifying a capability or calling multipart services", async () => {
    const fixture = handler();
    const response = new TestResponse();

    await expect(fixture.handler.handle(request("OPTIONS", "/v1/multipart-uploads", {
      origin: ORIGIN,
      "access-control-request-method": "POST",
      "access-control-request-headers":
        "authorization, content-type, idempotency-key, kokoro-contract-version",
    }), response.value)).resolves.toBe(true);

    expect(response.statusCode).toBe(204);
    expect(response.header("access-control-allow-origin")).toBe(ORIGIN);
    expect(response.header("access-control-allow-methods")).toBe("POST, OPTIONS");
    expect(response.header("access-control-allow-headers")).toBe(
      "authorization, content-type, idempotency-key, kokoro-contract-version",
    );
    expect(response.header("access-control-max-age")).toBe("300");
    expect(fixture.capabilities.verify).not.toHaveBeenCalled();
    expect(fixture.multipart.initiate).not.toHaveBeenCalled();
  });

  it("never reflects a rejected preflight origin", async () => {
    const fixture = handler({ allowOrigin: false });
    const response = new TestResponse();

    await fixture.handler.handle(request("OPTIONS", `/v1/multipart-uploads/${UPLOAD_REF}`, {
      origin: "https://attacker.example",
      "access-control-request-method": "GET",
      "access-control-request-headers": "authorization, kokoro-contract-version",
    }), response.value);

    expect(response.statusCode).toBe(403);
    expect(response.header("access-control-allow-origin")).toBeUndefined();
    expect(response.header("vary")).toBe("Origin");
    expect(response.json()).toMatchObject({ code: "UPLOAD_CAPABILITY_REJECTED" });
    expect(fixture.capabilities.verify).not.toHaveBeenCalled();
    expect(fixture.multipart.status).not.toHaveBeenCalled();
  });

  it("requires an exact capability origin, audience, and current policy before service access", async () => {
    const fixture = handler({ claims: claims({ allowedOrigins: ["https://other.example.test"] }) });
    const response = new TestResponse();

    await fixture.handler.handle(authenticatedRequest("GET", `/v1/multipart-uploads/${UPLOAD_REF}`),
      response.value);

    expect(response.statusCode).toBe(403);
    expect(response.header("access-control-allow-origin")).toBeUndefined();
    expect(fixture.multipart.status).not.toHaveBeenCalled();
  });

  it("rejects an expired or wrong-audience capability before service access", async () => {
    for (const rejectedClaims of [
      claims({ expiresAt: NOW }),
      claims({ audience: "another-audience" }),
    ]) {
      const fixture = handler({ claims: rejectedClaims });
      const response = new TestResponse();

      await fixture.handler.handle(authenticatedRequest("GET", `/v1/multipart-uploads/${UPLOAD_REF}`),
        response.value);

      expect(response.statusCode).toBe(401);
      expect(fixture.multipart.status).not.toHaveBeenCalled();
    }
  });

  it("returns a provider-neutral initiate representation with exact-origin CORS", async () => {
    const fixture = handler();
    const response = new TestResponse();

    await fixture.handler.handle(authenticatedRequest("POST", "/v1/multipart-uploads", {
      "content-type": "application/json",
      "idempotency-key": "initiate-command-0001",
    }, JSON.stringify({
      clientUploadId: "client_upload_0001",
      protocolRevision: "s3-multipart-v1",
    })), response.value);

    expect(response.statusCode).toBe(200);
    expect(response.header("access-control-allow-origin")).toBe(ORIGIN);
    expect(response.header("cache-control")).toBe("no-store");
    expect(response.header("x-content-type-options")).toBe("nosniff");
    expect(fixture.multipart.initiate).toHaveBeenCalledWith({
      claims: fixture.claims,
      clientUploadId: "client_upload_0001",
      idempotencyKey: "initiate-command-0001",
    });
    expect(response.json()).toMatchObject({
      receipt: { operation: "initiate", receiptRef: "initiation_receipt_0001" },
      upload: {
        uploadRef: UPLOAD_REF,
        state: "uploading",
        expectedSize: "1048576",
        partSize: "524288",
        retryClass: "after_user_action",
      },
    });
    expect(response.body).not.toContain("provider-upload-secret");
    expect(response.body).not.toContain("provider-etag-secret");
    expect(response.body).not.toContain("credential");
  });

  it("streams a part request directly and returns only a committed provider-neutral receipt", async () => {
    const committed = snapshot("uploading", [part("committed")]);
    const fixture = handler({ snapshot: committed });
    const response = new TestResponse();
    const source = authenticatedRequest("PUT", `/v1/multipart-uploads/${UPLOAD_REF}/parts/1`, {
      "content-type": "application/octet-stream",
      "idempotency-key": "put-part-command-0001",
      "x-kokoro-content-length": "4",
      "x-kokoro-content-sha256": "a".repeat(64),
    }, Buffer.from("data"));

    await fixture.handler.handle(source, response.value);

    expect(response.statusCode).toBe(200);
    expect(fixture.multipart.putPart).toHaveBeenCalledWith({
      claims: fixture.claims,
      uploadRef: UPLOAD_REF,
      partNumber: 1,
      declaredSize: 4n,
      checksumSha256: "a".repeat(64),
      idempotencyKey: "put-part-command-0001",
      body: source,
    });
    expect(response.json()).toMatchObject({
      part: { partNumber: 1, partReceipt: "part_receipt_0001", size: "4" },
      receipt: { operation: "put_part", state: "succeeded" },
    });
    expect(response.body).not.toContain("provider-etag-secret");
  });

  it("does not fabricate a part receipt while the provider outcome is unresolved", async () => {
    const fixture = handler({ snapshot: snapshot("uploading", [part("outcome_unknown")]) });
    const response = new TestResponse();

    await fixture.handler.handle(authenticatedRequest(
      "PUT", `/v1/multipart-uploads/${UPLOAD_REF}/parts/1`, {
        "idempotency-key": "put-part-command-0001",
        "x-kokoro-content-length": "4",
        "x-kokoro-content-sha256": "a".repeat(64),
      }, Buffer.from("data"),
    ), response.value);

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      code: "UPLOAD_TEMPORARILY_UNAVAILABLE",
      retryClass: "after_delay",
    });
    expect(response.body).not.toContain("provider-etag-secret");
  });

  it("rejects a part larger than the sealed capability before storage service access", async () => {
    const fixture = handler();
    const response = new TestResponse();

    await fixture.handler.handle(authenticatedRequest(
      "PUT", `/v1/multipart-uploads/${UPLOAD_REF}/parts/1`, {
        "idempotency-key": "put-part-command-0001",
        "x-kokoro-content-length": "524289",
        "x-kokoro-content-sha256": "a".repeat(64),
      }, Buffer.from("data"),
    ), response.value);

    expect(response.statusCode).toBe(413);
    expect(response.json()).toMatchObject({
      code: "UPLOAD_SIZE_EXCEEDED",
      retryClass: "after_user_action",
    });
    expect(fixture.multipart.putPart).not.toHaveBeenCalled();
  });

  it("represents integrity rejection as a stable terminal state", async () => {
    const fixture = handler({ snapshot: snapshot("integrity_rejected", [part("committed")]) });
    const response = new TestResponse();

    await fixture.handler.handle(authenticatedRequest(
      "GET", `/v1/multipart-uploads/${UPLOAD_REF}`,
    ), response.value);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      receipt: { operation: "complete", state: "integrity_rejected" },
      upload: {
        state: "integrity_rejected",
        retryClass: "never",
        retryAfter: null,
        safeReasonCode: "UPLOAD_PART_INVALID",
      },
    });
  });

  it("rejects queries, invalid contract headers, and oversized JSON before service access", async () => {
    const cases = [
      authenticatedRequest("GET", `/v1/multipart-uploads/${UPLOAD_REF}?provider=true`),
      authenticatedRequest("GET", `/v1/multipart-uploads/${UPLOAD_REF}`, {
        "kokoro-contract-version": "2",
      }),
      authenticatedRequest("POST", "/v1/multipart-uploads", {
        "content-type": "application/json",
        "content-length": "65537",
        "idempotency-key": "initiate-command-0001",
      }, "{}"),
    ];
    for (const source of cases) {
      const fixture = handler();
      const response = new TestResponse();
      await fixture.handler.handle(source, response.value);
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ code: "UPLOAD_NOT_ACCEPTED" });
      expect(fixture.multipart.initiate).not.toHaveBeenCalled();
      expect(fixture.multipart.status).not.toHaveBeenCalled();
    }
  });
});

function handler(options: Readonly<{
  allowOrigin?: boolean;
  claims?: AssetUploadCapabilityClaims;
  snapshot?: AuthorizedAssetMultipartSnapshot;
}> = {}) {
  const verifiedClaims = options.claims ?? claims();
  const result = options.snapshot ?? snapshot("uploading", [part("committed")]);
  const capabilities = { verify: vi.fn(() => verifiedClaims) };
  const policies = { allowsOrigin: vi.fn(() => options.allowOrigin ?? true) };
  const multipart = {
    initiate: vi.fn(async () => result),
    putPart: vi.fn(async () => result),
    complete: vi.fn(async () => result),
    abort: vi.fn(async () => result),
    status: vi.fn(async () => result),
  };
  return {
    claims: verifiedClaims,
    capabilities,
    multipart,
    handler: createAssetDataPlaneHttpHandler({
      expectedAudience: AUDIENCE,
      capabilities,
      policies,
      multipart,
      clock: () => new Date(NOW),
      requestId: () => REQUEST_ID,
    }),
  };
}

function authenticatedRequest(
  method: string,
  url: string,
  headers: Readonly<Record<string, string>> = {},
  body?: string | Buffer,
): IncomingMessage {
  return request(method, url, {
    authorization: `Bearer ${"c".repeat(64)}`,
    origin: ORIGIN,
    "kokoro-contract-version": "1",
    ...headers,
  }, body);
}

function request(
  method: string,
  url: string,
  headers: Readonly<Record<string, string>>,
  body?: string | Buffer,
): IncomingMessage {
  return Object.assign(Readable.from(body === undefined ? [] : [body]), {
    method,
    url,
    headers: Object.freeze({ ...headers }),
  }) as IncomingMessage;
}

class TestResponse {
  body = "";
  readonly headers = new Map<string, string>();
  readonly value = {
    statusCode: 200,
    setHeader: (name: string, value: string | number | readonly string[]) => {
      this.headers.set(name.toLowerCase(), Array.isArray(value) ? value.join(", ") : String(value));
      return this.value;
    },
    removeHeader: (name: string) => this.headers.delete(name.toLowerCase()),
    end: (body?: string | Buffer) => {
      this.body = body === undefined ? "" : body.toString();
      return this.value;
    },
  } as unknown as ServerResponse;

  get statusCode(): number {
    return this.value.statusCode;
  }

  header(name: string): string | undefined {
    return this.headers.get(name.toLowerCase());
  }

  json(): unknown {
    return JSON.parse(this.body) as unknown;
  }
}

function claims(overrides: Partial<AssetUploadCapabilityClaims> = {}): AssetUploadCapabilityClaims {
  return Object.freeze({
    version: 1,
    audience: AUDIENCE,
    storageTenantRef: "storage_tenant_0001",
    storageRegion: "us-east-1",
    siteRef: "site_0001",
    workloadIdentityId: "site_web_0001",
    siteReleaseRef: "site_release_0001",
    bindingEpoch: "1",
    subjectRef: "subject_0001",
    subjectGeneration: "1",
    projectRef: "project_0001",
    purpose: "chat.attachment",
    intentRef: "asset_intent_0001",
    sessionRef: "asset_session_0001",
    quarantineObjectRef: "quarantine/object/0001",
    expectedSize: "1048576",
    expectedChecksumSha256: "a".repeat(64),
    capabilityEpoch: "1",
    expiresAt: "2026-07-29T12:05:00.000Z",
    minimumPartBytes: "262144",
    maximumPartBytes: "524288",
    allowedOrigins: Object.freeze([ORIGIN]),
    ...overrides,
  });
}

function snapshot(
  state: StoredAssetMultipartUpload["state"],
  parts: readonly StoredAssetMultipartPart[],
): AuthorizedAssetMultipartSnapshot {
  return Object.freeze({ claims: claims(), parts: Object.freeze(parts), upload: Object.freeze({
    uploadRef: UPLOAD_REF,
    siteRef: "site_0001",
    intentRef: "asset_intent_0001",
    sessionRef: "asset_session_0001",
    clientUploadId: "client_upload_0001",
    providerUploadId: "provider-upload-secret",
    capabilityEpoch: 1n,
    state,
    outcomeOperation: state === "outcome_unknown" ? "complete" : null,
    expectedVersion: 2n,
    initiationIdempotencyKey: "initiate-command-0001",
    initiationRequestDigest: "a".repeat(64),
    initiationReceiptRef: "initiation_receipt_0001",
    initiationEffectToken: null,
    initiationEffectLeaseExpiresAt: null,
    completionIdempotencyKey: state === "uploading" ? null : "complete-command-0001",
    completionRequestDigest: state === "uploading" ? null : "b".repeat(64),
    completionReceiptRef: state === "uploading" ? null : "completion_receipt_0001",
    completionEffectToken: null,
    completionEffectLeaseExpiresAt: null,
    abortIdempotencyKey: null,
    abortRequestDigest: null,
    abortReceiptRef: null,
    abortEffectToken: null,
    abortEffectLeaseExpiresAt: null,
    createdAt: NOW,
    updatedAt: "2026-07-29T12:00:01.000Z",
  }) });
}

function part(state: StoredAssetMultipartPart["state"]): StoredAssetMultipartPart {
  return Object.freeze({
    partNumber: 1,
    partReceipt: "part_receipt_0001",
    providerEtag: "provider-etag-secret",
    size: 4n,
    checksumSha256: "a".repeat(64),
    idempotencyKey: "put-part-command-0001",
    requestDigest: "b".repeat(64),
    state,
    expectedVersion: 1n,
    effectToken: null,
    effectLeaseExpiresAt: null,
  });
}
