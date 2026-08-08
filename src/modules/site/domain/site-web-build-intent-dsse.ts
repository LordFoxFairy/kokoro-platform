export const SITE_WEB_BUILD_INTENT_PAYLOAD_TYPE =
  "application/vnd.kokoro.web-build-intent.v1+json" as const;

export interface SiteWebBuildIntentDsseEnvelope {
  readonly payloadType: typeof SITE_WEB_BUILD_INTENT_PAYLOAD_TYPE;
  readonly payload: string;
  readonly signatures: readonly [Readonly<{ keyid: string; sig: string }>];
}

export function createSiteWebBuildIntentDsseEnvelope(input: Readonly<{
  payloadType: string;
  payload: string;
  signatures: readonly Readonly<{ keyid: string; sig: string }>[];
}>): SiteWebBuildIntentDsseEnvelope {
  if (input.payloadType !== SITE_WEB_BUILD_INTENT_PAYLOAD_TYPE ||
      !canonicalBase64(input.payload, 2, 1_398_104) || input.signatures.length !== 1) {
    throw new Error("SITE_WEB_BUILD_INTENT_ENVELOPE_INVALID");
  }
  const signature = input.signatures[0];
  if (signature === undefined || !reference(signature.keyid) ||
      !canonicalBase64(signature.sig, 64, 16_384) ||
      Buffer.from(signature.sig, "base64").byteLength !== 64) {
    throw new Error("SITE_WEB_BUILD_INTENT_ENVELOPE_INVALID");
  }
  const signatures = Object.freeze([Object.freeze({
    keyid: signature.keyid,
    sig: signature.sig,
  })] as const);
  return Object.freeze({
    payloadType: SITE_WEB_BUILD_INTENT_PAYLOAD_TYPE,
    payload: input.payload,
    signatures,
  });
}

export function decodeSiteWebBuildIntentDssePayload(
  envelope: SiteWebBuildIntentDsseEnvelope,
): Uint8Array {
  return new Uint8Array(Buffer.from(envelope.payload, "base64"));
}

export function siteWebBuildIntentDssePae(payloadType: string, payload: Uint8Array): Uint8Array {
  const type = Buffer.from(payloadType, "utf8");
  const body = Buffer.from(payload);
  return new Uint8Array(Buffer.concat([
    Buffer.from(`DSSEv1 ${type.byteLength} `, "ascii"),
    type,
    Buffer.from(` ${body.byteLength} `, "ascii"),
    body,
  ]));
}

function canonicalBase64(value: string, minimumBytes: number, maximumLength: number): boolean {
  if (value.length < 1 || value.length > maximumLength ||
      !/^[A-Za-z0-9+/]+={0,2}$/u.test(value)) return false;
  const decoded = Buffer.from(value, "base64");
  return decoded.byteLength >= minimumBytes && decoded.toString("base64") === value;
}

function reference(value: string): boolean {
  return value.length >= 3 && value.length <= 200 &&
    /^[a-z][a-z0-9]*(?:[._/-][a-z0-9]+)+$/u.test(value);
}
