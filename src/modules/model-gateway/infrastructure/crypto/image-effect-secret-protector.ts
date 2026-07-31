import { createHash } from "node:crypto";
import type {
  ModelGatewayResponseBinding,
  ModelGatewayResponseProtector,
} from "./response-protector.js";
import type { ImageEffectSecretProtector } from "../postgres/image-effect-postgres.js";

export function createImageEffectSecretProtector(
  protector: ModelGatewayResponseProtector,
): ImageEffectSecretProtector {
  const adapter: ImageEffectSecretProtector = {
    seal: (plaintext, context) => protector.seal(plaintext, binding(context)),
    unseal: (envelope, context) => protector.unseal(envelope, binding(context)),
  };
  return Object.freeze(adapter);
}

function binding(context: Parameters<ImageEffectSecretProtector["seal"]>[1]): ModelGatewayResponseBinding {
  for (const value of [context.siteId, context.logicalInvocationRef, context.bindingRef]) {
    if (value.length < 1 || value.length > 256 || /[\0\r\n]/u.test(value)) {
      throw new Error("IMAGE_EFFECT_SECRET_BINDING_INVALID");
    }
  }
  const requestDigest = createHash("sha256")
    .update("kokoro.platform.model.image-effect.secret.v1\0", "utf8")
    .update(context.purpose, "utf8")
    .update("\0", "utf8")
    .update(context.bindingRef, "utf8")
    .digest("hex");
  return Object.freeze({
    siteId: context.siteId,
    invocationRef: context.logicalInvocationRef,
    requestDigest,
    purpose: context.purpose === "source-grants" ? "request" : "response",
  });
}
