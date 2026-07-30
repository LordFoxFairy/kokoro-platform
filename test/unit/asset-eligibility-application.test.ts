import { describe, expect, it, vi } from "vitest";
import { AssetEligibilityApplicationService, AssetEligibilityError } from
  "../../src/modules/asset/application/services/asset-eligibility.js";
import type { PlatformTransaction } from "../../src/shared/unit-of-work/index.js";

const transaction = Object.freeze({}) as PlatformTransaction;
const caller = Object.freeze({
  identity: "spiffe://kokoro/session", environment: "production", region: "us-east-1",
});
const request = Object.freeze({
  siteId: "site-a",
  sessionAccessGrant: "opaque-grant-a",
  sessionId: "session-a",
  purpose: "chat.attachment",
  attachments: Object.freeze([
    Object.freeze({ assetRef: "asset-b", assetVersionRef: "version-b", assetGrantRef: "grant-b" }),
    Object.freeze({ assetRef: "asset-a", assetVersionRef: "version-a", assetGrantRef: "grant-a" }),
  ]),
});

function setup(input: Readonly<{
  authority?: unknown;
  attachments?: unknown;
}> = {}) {
  const events: string[] = [];
  const authority = input.authority === undefined ? {
    siteId: "site-a", siteReleaseRef: "release-a", projectRef: "project-a",
    subjectRef: "subject-a", subjectGeneration: 7n, identitySessionRef: "identity-session-a",
    resource: { kind: "session" as const, sessionRef: "session-a" },
  } : input.authority;
  const resolved = input.attachments === undefined ? request.attachments.map((attachment, index) => ({
    ...attachment,
    checksumSha256: String(index + 1).repeat(64),
    safeDisplayName: index === 0 ? "diagram.png" : "notes.txt",
    detectedMediaType: index === 0 ? "image/png" : "text/plain",
    sizeBytes: BigInt(index + 1),
    eligibilityEpoch: BigInt(index + 9),
  })) : input.attachments;
  const verifier = { verify: vi.fn(async () => { events.push("grant.verify"); return authority as never; }) };
  const scopeOwner = vi.fn(async () => { events.push("asset.scope"); });
  const assetQueries = {
    resolveSessionAttachments: vi.fn(async () => {
      events.push("asset.resolve");
      if (resolved instanceof Error) throw resolved;
      return resolved as never;
    }),
  };
  const unitOfWork = {
    checkActive: vi.fn(async () => { events.push("db.check-active"); }),
    execute: vi.fn(async (_input, work) => {
      events.push("tx.begin");
      try { return await work(transaction); } finally { events.push("tx.end"); }
    }),
    scopeOwner,
  };
  const service = new AssetEligibilityApplicationService({
    unitOfWork,
    verifier,
    assetQueries,
    sessionCallerIdentity: caller.identity,
  });
  return { service, unitOfWork, verifier, scopeOwner, assetQueries, events };
}

describe("AssetEligibilityApplicationService", () => {
  it("derives owner facts from the opaque grant, scopes RLS, and preserves exact caller order", async () => {
    const subject = setup();
    await expect(subject.service.resolveSessionAttachments(request, caller, new AbortController().signal))
      .resolves.toMatchObject([
        { assetRef: "asset-b", safeDisplayName: "diagram.png", sizeBytes: 1n },
        { assetRef: "asset-a", safeDisplayName: "notes.txt", sizeBytes: 2n },
      ]);
    expect(subject.events).toEqual(["tx.begin", "grant.verify", "asset.scope", "asset.resolve", "tx.end"]);
    expect(subject.verifier.verify).toHaveBeenCalledWith(transaction, {
      siteId: "site-a", credential: "opaque-grant-a", purpose: "write",
      environment: "production", region: "us-east-1",
    });
    const authority = {
      siteRef: "site-a", subjectRef: "subject-a", subjectGeneration: 7n, projectRef: "project-a",
    };
    expect(subject.scopeOwner).toHaveBeenCalledWith(transaction, {
      ...authority, purpose: "chat.attachment",
    });
    expect(subject.assetQueries.resolveSessionAttachments).toHaveBeenCalledWith({
      transaction, authority, purpose: "chat.attachment", attachments: request.attachments,
    });
  });

  it("allows only the exact mTLS-authenticated Session workload, including readiness", async () => {
    const subject = setup();
    await expect(subject.service.checkActive(caller, new AbortController().signal)).resolves.toEqual({
      contractRevision: "platform-asset-eligibility@v1",
    });
    const other = { ...caller, identity: "spiffe://kokoro/admin" };
    await expect(subject.service.checkActive(other, new AbortController().signal))
      .rejects.toBeInstanceOf(AssetEligibilityError);
    expect(subject.unitOfWork.checkActive).toHaveBeenCalledOnce();
    await expect(subject.service.resolveSessionAttachments(request, other, new AbortController().signal))
      .rejects.toMatchObject({ code: "CALLER_NOT_AUTHORIZED" });
    expect(subject.unitOfWork.execute).not.toHaveBeenCalled();
  });

  it("rejects unbounded input and every non-canonical attachment purpose before owner access", async () => {
    const subject = setup();
    await expect(subject.service.resolveSessionAttachments(
      { ...request, purpose: "chat_run_input" }, caller, new AbortController().signal,
    )).rejects.toMatchObject({ code: "INPUT_INVALID" });
    await expect(subject.service.resolveSessionAttachments(
      { ...request, attachments: Array.from({ length: 65 }, () => request.attachments[0]!) },
      caller,
      new AbortController().signal,
    )).rejects.toMatchObject({ code: "INPUT_INVALID" });
    expect(subject.verifier.verify).not.toHaveBeenCalled();
  });

  it.each([
    ["stale or revoked grant", { authority: null }],
    ["grant outside the exact Session resource", { authority: {
      siteId: "site-a", siteReleaseRef: "release-a", projectRef: "project-a",
      subjectRef: "subject-a", subjectGeneration: 7n, identitySessionRef: "identity-session-a",
      resource: { kind: "session", sessionRef: "other-session" },
    } }],
    ["stale or cross-scope asset", { attachments: new Error("ASSET_NOT_ACCEPTED") }],
  ])("uses one rejection for %s", async (_label, overrides) => {
    const subject = setup(overrides);
    await expect(subject.service.resolveSessionAttachments(request, caller, new AbortController().signal))
      .rejects.toMatchObject({ code: "NOT_ACCEPTED", message: "ASSET_ELIGIBILITY_NOT_ACCEPTED" });
  });
});
