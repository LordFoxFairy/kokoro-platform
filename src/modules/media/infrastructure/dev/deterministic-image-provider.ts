import { createHash } from "node:crypto";
import type {
  ImageProviderAdapter,
  ImageProviderOutcome,
} from "../../application/image-operation-worker.js";

// Valid 1x1 transparent PNG. This fake never performs network or provider I/O.
const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

/** Explicitly development-only. Production composition rejects `developmentOnly` adapters. */
export class DeterministicDevelopmentImageProviderAdapter implements ImageProviderAdapter {
  readonly developmentOnly = true as const;
  readonly adapterKind = "deterministic-development-image";
  readonly #outcomes = new Map<string, ImageProviderOutcome>();
  readonly #events: string[];
  invocationCount = 0;

  constructor(events: string[] = []) { this.#events = events; }

  async createOrRecover(input: Parameters<ImageProviderAdapter["createOrRecover"]>[0]) {
    if (input.signal.aborted) throw input.signal.reason ?? new DOMException("Aborted", "AbortError");
    const digest = createHash("sha256").update(JSON.stringify({ commandRef: input.commandRef,
      request: input.request })).digest("hex");
    const prior = this.#outcomes.get(digest);
    if (prior !== undefined) return prior;
    this.#events.push("provider.create-or-recover");
    this.invocationCount += 1;
    if (input.request.outputFormat !== "png") throw new Error("DEVELOPMENT_IMAGE_FORMAT_UNSUPPORTED");
    const mediaType = "image/png" as const;
    const outputs = Array.from({ length: input.request.candidateCount }, (_, index) => Object.freeze({
      candidateOrdinal: index + 1,
      bytes: new Uint8Array(ONE_PIXEL_PNG),
      mediaType,
      width: 1,
      height: 1,
      providerOutputFactRef: `provider-output-fact:sha256:${createHash("sha256")
        .update("kokoro.dev.image-output.v1\0").update(digest).update("\0").update(String(index + 1))
        .digest("hex")}`,
    }));
    const outcome = Object.freeze({
      providerEffectRef: `provider-effect:sha256:${digest}`,
      providerUsage: Object.freeze({ unit: "image" as const, quantity: BigInt(outputs.length) }),
      outputs: Object.freeze(outputs),
    });
    this.#outcomes.set(digest, outcome);
    return outcome;
  }
}
