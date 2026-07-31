import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import {
  ArtifactDeliveryRangeError,
  createArtifactDataPlaneHttpHandler,
} from "../../src/interfaces/http/artifact-data-plane.js";

const workload = Object.freeze({
  workloadIdentityId: "workload:site-bff:one",
  siteRef: "site:one",
  siteReleaseRef: "site-release:one",
  audience: "platform-public",
  environment: "production" as const,
  region: "us-east-1",
  bindingEpoch: "4",
  siteSecurityEpoch: "7",
  policyEpoch: "8",
});

describe("Artifact binary data plane", () => {
  it("uses the generated GET route and streams a bounded range without JSON buffering", async () => {
    const redeem = vi.fn(async () => Object.freeze({
      status: 206 as const,
      headers: Object.freeze({
        contentType: "image/png",
        contentLength: "4",
        contentRange: "bytes 2-5/10",
        contentDisposition: 'attachment; filename="artifact.png"',
        eTag: `"${"a".repeat(64)}"`,
        acceptRanges: "bytes" as const,
      }),
      body: chunks(Uint8Array.of(2, 3), Uint8Array.of(4, 5)),
    }));
    const handler = createArtifactDataPlaneHttpHandler({
      workloads: { authenticate: vi.fn(() => workload) },
      delivery: { redeem },
      requestId: () => "request:one",
    });
    const request = incoming({
      url: "/v1/artifact-delivery-authorizations/authorization:one/content",
      headers: {
        "kokoro-contract-version": "1",
        "x-kokoro-request-deadline-ms": "5000",
        "x-kokoro-artifact-delivery-capability": "d".repeat(64),
        range: "bytes=2-5",
      },
    });
    const response = new ResponseDouble();

    await expect(handler.handle(request, response.value)).resolves.toBe(true);

    expect(redeem).toHaveBeenCalledWith(expect.objectContaining({
      authorizationRef: "authorization:one",
      deliveryCapability: "d".repeat(64),
      rangeHeader: "bytes=2-5",
      requestRef: "request:one",
      workload: expect.objectContaining({
        siteRef: "site:one",
        workloadIdentityRef: "workload:site-bff:one",
        workloadBindingEpoch: 4n,
      }),
    }));
    expect(response.statusCode).toBe(206);
    expect(response.header("content-range")).toBe("bytes 2-5/10");
    // The internal owner validates a strong digest fence, but Root OpenAPI has not
    // promoted ETag to the public response contract yet.
    expect(response.header("etag")).toBeUndefined();
    expect(Buffer.concat(response.chunks)).toEqual(Buffer.from([2, 3, 4, 5]));
  });

  it("waits for response drain before pulling the next storage chunk", async () => {
    const pulls: number[] = [];
    async function* body() {
      pulls.push(1); yield Uint8Array.of(1);
      pulls.push(2); yield Uint8Array.of(2);
    }
    const handler = createArtifactDataPlaneHttpHandler({
      workloads: { authenticate: () => workload },
      delivery: { redeem: async () => Object.freeze({
        status: 200 as const,
        headers: Object.freeze({ contentType: "image/png", contentLength: "2",
          contentDisposition: 'inline; filename="artifact.png"',
          eTag: `"${"b".repeat(64)}"`, acceptRanges: "bytes" as const }),
        body: body(),
      }) },
      requestId: () => "request:drain",
    });
    const response = new ResponseDouble([false, true]);
    const pending = handler.handle(incoming({ headers: validHeaders() }), response.value);
    await vi.waitFor(() => expect(pulls).toEqual([1]));
    response.emitDrain();
    await pending;
    expect(pulls).toEqual([1, 2]);
  });

  it("returns the contracted bounded problem body and exact total size for a 416", async () => {
    const handler = createArtifactDataPlaneHttpHandler({
      workloads: { authenticate: () => workload },
      delivery: { redeem: async () => {
        throw new ArtifactDeliveryRangeError("ARTIFACT_RANGE_UNSATISFIABLE", 10n);
      } },
      requestId: () => "request:range",
    });
    const response = new ResponseDouble();
    await handler.handle(incoming({ headers: { ...validHeaders(), range: "bytes=20-21" } }), response.value);

    expect(response.statusCode).toBe(416);
    expect(response.header("content-range")).toBe("bytes */10");
    expect(response.header("content-type")).toBe("application/problem+json; charset=utf-8");
    expect(JSON.parse(Buffer.concat(response.chunks).toString("utf8"))).toEqual({
      code: "ARTIFACT_RANGE_NOT_SATISFIABLE",
      correlationId: "request:range",
      requestId: "request:range",
      retryClass: "never",
      safeMessage: "The requested artifact byte range is not satisfiable.",
    });
    expect(response.header("content-length")).toBe(String(Buffer.concat(response.chunks).byteLength));
  });

  it("does not invent an unregistered HEAD operation", async () => {
    const authenticate = vi.fn();
    const redeem = vi.fn();
    const handler = createArtifactDataPlaneHttpHandler({
      workloads: { authenticate }, delivery: { redeem }, requestId: () => "request:head",
    });
    const response = new ResponseDouble();

    await expect(handler.handle(incoming({ method: "HEAD", headers: validHeaders() }), response.value))
      .resolves.toBe(false);
    expect(authenticate).not.toHaveBeenCalled();
    expect(redeem).not.toHaveBeenCalled();
  });

  it("destroys an already-started response when storage overruns the declared length", async () => {
    const handler = createArtifactDataPlaneHttpHandler({
      workloads: { authenticate: () => workload },
      delivery: { redeem: async () => Object.freeze({
        status: 200 as const,
        headers: Object.freeze({ contentType: "image/png", contentLength: "1",
          contentDisposition: 'inline; filename="artifact.png"',
          eTag: `"${"c".repeat(64)}"`, acceptRanges: "bytes" as const }),
        body: chunks(Uint8Array.of(1), Uint8Array.of(2)),
      }) },
      requestId: () => "request:overrun",
    });
    const response = new ResponseDouble();

    await handler.handle(incoming({ headers: validHeaders() }), response.value);

    expect(response.destroyed).toBe(true);
    expect(response.chunks).toEqual([Buffer.from([1])]);
  });

  it("aborts a stalled storage stream at the generated request deadline", async () => {
    vi.useFakeTimers();
    try {
      let observedSignal: AbortSignal | undefined;
      const handler = createArtifactDataPlaneHttpHandler({
        workloads: { authenticate: () => workload },
        delivery: { redeem: async (input) => {
          observedSignal = input.signal;
          return Object.freeze({
          status: 200 as const,
          headers: Object.freeze({ contentType: "image/png", contentLength: "1",
            contentDisposition: 'inline; filename="artifact.png"',
            eTag: `"${"d".repeat(64)}"`, acceptRanges: "bytes" as const }),
          body: stalled(input.signal),
        }); } },
        requestId: () => "request:deadline",
      });
      const response = new ResponseDouble();
      const pending = handler.handle(incoming({ headers: {
        ...validHeaders(), "x-kokoro-request-deadline-ms": "10",
      } }), response.value);
      await vi.advanceTimersByTimeAsync(11);
      await pending;
      expect(observedSignal?.aborted).toBe(true);
      expect(response.statusCode).toBe(503);
      expect(JSON.parse(Buffer.concat(response.chunks).toString("utf8"))).toMatchObject({
        code: "ARTIFACT_TEMPORARILY_UNAVAILABLE",
        retryClass: "after_delay",
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

function validHeaders(): Record<string, string> {
  return {
    "kokoro-contract-version": "1",
    "x-kokoro-request-deadline-ms": "5000",
    "x-kokoro-artifact-delivery-capability": "d".repeat(64),
  };
}

function incoming(input: Readonly<{
  method?: string;
  url?: string;
  headers?: Readonly<Record<string, string>>;
}> = {}): IncomingMessage {
  const stream = new PassThrough();
  Object.defineProperties(stream, {
    method: { value: input.method ?? "GET", configurable: true },
    url: { value: input.url ?? "/v1/artifact-delivery-authorizations/authorization:one/content",
      configurable: true },
    headers: { value: input.headers ?? {}, configurable: true },
  });
  stream.end();
  return stream as unknown as IncomingMessage;
}

async function* chunks(...values: Uint8Array[]): AsyncGenerator<Uint8Array> {
  for (const value of values) yield value;
}

function stalled(signal: AbortSignal): AsyncIterable<Uint8Array> {
  return Object.freeze({
    [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
      return Object.freeze({
        async next(): Promise<IteratorResult<Uint8Array>> {
          await new Promise<void>((_resolve, reject) => {
            const abort = () => reject(signal.reason);
            if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
          });
          return Object.freeze({ done: true, value: undefined });
        },
      });
    },
  });
}

class ResponseDouble extends EventEmitter {
  readonly chunks: Buffer[] = [];
  readonly headers = new Map<string, string>();
  readonly value: ServerResponse;
  statusCode = 200;
  headersSent = false;
  destroyed = false;
  #writes: boolean[];

  constructor(writes: boolean[] = []) {
    super();
    this.#writes = [...writes];
    this.value = this as unknown as ServerResponse;
  }

  setHeader(name: string, value: string | number | readonly string[]): this {
    this.headers.set(name.toLowerCase(), Array.isArray(value) ? value.join(", ") : String(value));
    return this;
  }

  write(chunk: Uint8Array): boolean {
    this.headersSent = true;
    this.chunks.push(Buffer.from(chunk));
    return this.#writes.shift() ?? true;
  }

  end(chunk?: Uint8Array | string): this {
    this.headersSent = true;
    if (chunk !== undefined) this.chunks.push(Buffer.from(chunk));
    this.emit("finish");
    return this;
  }

  destroy(): this {
    this.destroyed = true;
    this.emit("close");
    return this;
  }

  header(name: string): string | undefined { return this.headers.get(name); }
  emitDrain(): void { this.emit("drain"); }
}
