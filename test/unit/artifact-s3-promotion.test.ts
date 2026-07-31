import { createHash } from "node:crypto";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { describe, expect, it, vi } from "vitest";
import { S3ArtifactObjectStore } from
  "../../src/modules/artifact/infrastructure/s3/s3-artifact-object-store.js";

const bytes = new TextEncoder().encode("immutable image bytes");
const contentSha256 = createHash("sha256").update(bytes).digest("hex");
const stagedReceipt = Object.freeze({
  ownerScope: Object.freeze({ siteRef: "site:one", subjectRef: "subject:one",
    subjectGeneration: 1n, projectRef: "project:one" }),
  artifactRef: "artifact:one",
  artifactVersionRef: "artifact-version:one",
  stagedObjectRef: "",
  contentSha256,
  byteSize: BigInt(bytes.byteLength),
  mediaType: "image/png" as const,
  state: "staged" as const,
});

describe("S3 Artifact immutable promotion", () => {
  it("lets a worker recover after the immutable ready write won before metadata recording", async () => {
    const send = vi.fn().mockResolvedValueOnce(head(true));
    const store = new S3ArtifactObjectStore({ client: { send } as never, bucket: "artifact-bucket" });

    await expect(store.stage({ ownerScope: stagedReceipt.ownerScope,
      artifactRef: stagedReceipt.artifactRef, artifactVersionRef: stagedReceipt.artifactVersionRef,
      bytes, mediaType: "image/png",
    })).resolves.toMatchObject({ state: "staged", contentSha256 });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("reads the exact staged etag and conditionally creates the immutable version key", async () => {
    const send = vi.fn()
      .mockRejectedValueOnce(notFound())
      .mockResolvedValueOnce(head(false))
      .mockResolvedValueOnce({ ContentLength: bytes.byteLength, Body: body(bytes) })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce(head(true))
      .mockResolvedValueOnce({});
    const store = new S3ArtifactObjectStore({ client: { send } as never, bucket: "artifact-bucket" });
    const staged = stagedWithObjectRef();

    await expect(store.promote({ stagedReceipt: staged, trustDecision: {
      kind: "allow", decisionRef: "trust:allow:one", contentSha256,
    } })).resolves.toMatchObject({ artifactVersionRef: "artifact-version:one", state: "ready_private" });

    expect(send.mock.calls[0]?.[0]).toBeInstanceOf(HeadObjectCommand);
    const get = send.mock.calls[2]?.[0] as GetObjectCommand;
    expect(get).toBeInstanceOf(GetObjectCommand);
    expect(get.input.IfMatch).toBe('"staged-etag"');
    const put = send.mock.calls[3]?.[0] as PutObjectCommand;
    expect(put).toBeInstanceOf(PutObjectCommand);
    expect(put.input).toMatchObject({ IfNoneMatch: "*", ContentLength: bytes.byteLength,
      ContentType: "image/png" });
    expect(send.mock.calls[5]?.[0]).toBeInstanceOf(DeleteObjectCommand);
  });

  it("refuses promotion when bytes no longer match the trusted staged digest", async () => {
    const changed = new TextEncoder().encode("modified image bytes!");
    const send = vi.fn()
      .mockRejectedValueOnce(notFound())
      .mockResolvedValueOnce(head(false))
      .mockResolvedValueOnce({ ContentLength: changed.byteLength, Body: body(changed) });
    const store = new S3ArtifactObjectStore({ client: { send } as never, bucket: "artifact-bucket" });
    const staged = stagedWithObjectRef();

    await expect(store.promote({ stagedReceipt: { ...staged, byteSize: BigInt(changed.byteLength) },
      trustDecision: { kind: "allow", decisionRef: "trust:allow:one", contentSha256 },
    })).rejects.toThrow("ARTIFACT_PROMOTION_SOURCE_CHANGED");
    expect(send.mock.calls.some(([command]) => command instanceof PutObjectCommand)).toBe(false);
  });

  it("returns ready with durable cleanup-pending evidence when staged deletion is ambiguous", async () => {
    const send = vi.fn()
      .mockRejectedValueOnce(notFound())
      .mockResolvedValueOnce(head(false))
      .mockResolvedValueOnce({ ContentLength: bytes.byteLength, Body: body(bytes) })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce(head(true))
      .mockRejectedValueOnce(new Error("delete timeout"));
    const store = new S3ArtifactObjectStore({ client: { send } as never, bucket: "artifact-bucket" });

    await expect(store.promote({ stagedReceipt: stagedWithObjectRef(), trustDecision: {
      kind: "allow", decisionRef: "trust:allow:one", contentSha256,
    } })).resolves.toMatchObject({
      state: "ready_private",
      stagedCleanup: { state: "pending", stagedObjectRef: stagedWithObjectRef().stagedObjectRef },
    });
  });

  it("recovers an already-ready object without hiding an ambiguous staged cleanup", async () => {
    const send = vi.fn()
      .mockResolvedValueOnce(head(true))
      .mockRejectedValueOnce(new Error("delete timeout"));
    const store = new S3ArtifactObjectStore({ client: { send } as never, bucket: "artifact-bucket" });

    await expect(store.promote({ stagedReceipt: stagedWithObjectRef(), trustDecision: {
      kind: "allow", decisionRef: "trust:allow:one", contentSha256,
    } })).resolves.toMatchObject({
      state: "ready_private",
      stagedCleanup: { state: "pending", stagedObjectRef: stagedWithObjectRef().stagedObjectRef },
    });
    expect(send.mock.calls[1]?.[0]).toBeInstanceOf(DeleteObjectCommand);
  });

  it("does not claim cleanup completed when ready metadata still has a staged object", async () => {
    const send = vi.fn()
      .mockResolvedValueOnce(head(true))
      .mockResolvedValueOnce(head(false));
    const store = new S3ArtifactObjectStore({ client: { send } as never, bucket: "artifact-bucket" });

    await expect(store.describeReady({ ownerScope: stagedReceipt.ownerScope,
      artifactRef: stagedReceipt.artifactRef, artifactVersionRef: stagedReceipt.artifactVersionRef,
    })).resolves.toMatchObject({
      state: "ready_private",
      stagedCleanup: { state: "pending", stagedObjectRef: stagedWithObjectRef().stagedObjectRef },
    });
    expect(send.mock.calls[1]?.[0]).toBeInstanceOf(HeadObjectCommand);
  });

  it("conditionally opens the exact ready etag and validates response identity", async () => {
    const send = vi.fn()
      .mockResolvedValueOnce(head(true))
      .mockResolvedValueOnce({ ...head(true), Body: body(bytes) });
    const store = new S3ArtifactObjectStore({ client: { send } as never, bucket: "artifact-bucket" });

    const opened = await store.openReady({ ownerScope: stagedReceipt.ownerScope,
      artifactRef: stagedReceipt.artifactRef, artifactVersionRef: stagedReceipt.artifactVersionRef,
      signal: new AbortController().signal });
    const received: Uint8Array[] = [];
    for await (const chunk of opened.body) received.push(chunk);

    const get = send.mock.calls[1]?.[0] as GetObjectCommand;
    expect(get.input.IfMatch).toBe('"ready-etag"');
    expect(Buffer.concat(received)).toEqual(Buffer.from(bytes));
  });

  it("rejects a ready GET whose response identity no longer matches its HEAD fence", async () => {
    const send = vi.fn()
      .mockResolvedValueOnce(head(true))
      .mockResolvedValueOnce({ ...head(true), ETag: '"different-etag"', Body: body(bytes) });
    const store = new S3ArtifactObjectStore({ client: { send } as never, bucket: "artifact-bucket" });

    await expect(store.openReady({ ownerScope: stagedReceipt.ownerScope,
      artifactRef: stagedReceipt.artifactRef, artifactVersionRef: stagedReceipt.artifactVersionRef,
      signal: new AbortController().signal })).rejects.toThrow("ARTIFACT_OBJECT_RESPONSE_INVALID");
  });

  it("detects full-object corruption even when S3 response identity metadata matches", async () => {
    const changed = Uint8Array.from(bytes);
    changed[0] = changed[0]! ^ 1;
    const send = vi.fn()
      .mockResolvedValueOnce(head(true))
      .mockResolvedValueOnce({ ...head(true), Body: body(changed) });
    const store = new S3ArtifactObjectStore({ client: { send } as never, bucket: "artifact-bucket" });

    const opened = await store.openReady({ ownerScope: stagedReceipt.ownerScope,
      artifactRef: stagedReceipt.artifactRef, artifactVersionRef: stagedReceipt.artifactVersionRef,
      signal: new AbortController().signal });
    const drain = async () => {
      for await (const _chunk of opened.body) { /* drain and verify terminal digest */ }
    };
    await expect(drain()).rejects.toThrow("ARTIFACT_OBJECT_BODY_DIGEST_MISMATCH");
  });
});

function stagedWithObjectRef() {
  const identity = createHash("sha256").update("kokoro.platform.artifact-object.v1\0")
    .update(frame("site:one")).update(frame("subject:one")).update(frame("1"))
    .update(frame("project:one")).update(frame("artifact:one")).update(frame("artifact-version:one"))
    .digest("hex");
  const key = `kokoro/artifacts/v1/staged/${identity.slice(0, 2)}/${identity}`;
  return Object.freeze({ ...stagedReceipt,
    stagedObjectRef: `artifact-object:sha256:${createHash("sha256").update(key).digest("hex")}` });
}

function head(ready: boolean) {
  return { ContentLength: bytes.byteLength, ContentType: "image/png",
    ETag: ready ? '"ready-etag"' : '"staged-etag"',
    Metadata: { "content-sha256": contentSha256, "byte-size": String(bytes.byteLength),
      ...(ready ? { "trust-decision-ref": "trust:allow:one" } : {}) } };
}

function notFound(): Error {
  return Object.assign(new Error("missing"), { name: "NoSuchKey", $metadata: { httpStatusCode: 404 } });
}

async function* body(value: Uint8Array): AsyncGenerator<Uint8Array> { yield value; }

function frame(value: string): Buffer {
  const raw = Buffer.from(value);
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32BE(raw.byteLength);
  return Buffer.concat([length, raw]);
}
