import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const TOKEN_PATTERN = /^artdel_v1\.([A-Za-z0-9_-]{43})\.([0-9a-f]{64})$/u;
const DOMAIN = "kokoro.platform.artifact-delivery.v1\0";

/** Sole authority for the Artifact delivery bearer wire format. */
export class ArtifactDeliveryCapabilityCodec {
  readonly #key: Buffer;

  constructor(key: Uint8Array, private readonly entropy: () => Uint8Array = () => randomBytes(32)) {
    if (!(key instanceof Uint8Array) || key.byteLength !== 32) {
      throw new Error("ARTIFACT_DELIVERY_KEY_INVALID");
    }
    this.#key = Buffer.from(key);
  }

  issue(): Readonly<{ deliveryCapability: string; capabilityDigest: string }> {
    const entropy = this.entropy();
    if (!(entropy instanceof Uint8Array) || entropy.byteLength !== 32) {
      throw new Error("ARTIFACT_DELIVERY_ENTROPY_INVALID");
    }
    const bearer = Buffer.from(entropy).toString("base64url");
    const capabilityDigest = this.#digest(bearer);
    return Object.freeze({
      deliveryCapability: `artdel_v1.${bearer}.${capabilityDigest}`,
      capabilityDigest,
    });
  }

  verify(deliveryCapability: string): string {
    const match = TOKEN_PATTERN.exec(deliveryCapability);
    if (match === null) throw new Error("ARTIFACT_DELIVERY_CAPABILITY_INVALID");
    const expected = Buffer.from(this.#digest(match[1]!), "hex");
    const supplied = Buffer.from(match[2]!, "hex");
    if (supplied.byteLength !== expected.byteLength || !timingSafeEqual(supplied, expected)) {
      throw new Error("ARTIFACT_DELIVERY_CAPABILITY_INVALID");
    }
    return match[2]!;
  }

  #digest(bearer: string): string {
    return createHmac("sha256", this.#key).update(DOMAIN).update(bearer).digest("hex");
  }
}
