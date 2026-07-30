import type { AssetInspectionPolicyResolverPort } from
  "../../application/contracts/asset-scan-worker-ports.js";
import type { AssetInspectionPolicy } from "../../domain/scan-evaluation.js";

type ScopedPolicy = Readonly<AssetInspectionPolicy & { siteRef: string }>;

export class AssetInspectionPolicyRegistry implements AssetInspectionPolicyResolverPort {
  readonly #policies = new Map<string, ScopedPolicy>();

  constructor(policies: readonly ScopedPolicy[]) {
    if (policies.length < 1 || policies.length > 2_048) invalid();
    for (const policy of policies) {
      const key = policyKey(policy.siteRef, policy.policyRevisionRef, policy.purpose);
      if (this.#policies.has(key)) invalid();
      this.#policies.set(key, Object.freeze({
        ...policy,
        allowedDetectedMediaTypes: Object.freeze([...policy.allowedDetectedMediaTypes]),
      }));
    }
  }

  async resolve(input: Readonly<{
    siteRef: string;
    policyRevisionRef: string;
    purpose: string;
  }>): Promise<AssetInspectionPolicy> {
    const policy = this.#policies.get(policyKey(input.siteRef, input.policyRevisionRef, input.purpose));
    if (policy === undefined) throw new Error("ASSET_INSPECTION_POLICY_NOT_CONFIGURED");
    const { siteRef: _siteRef, ...resolved } = policy;
    return Object.freeze(resolved);
  }
}

export function parseAssetInspectionPolicyRegistry(value: unknown): AssetInspectionPolicyRegistry {
  const root = record(value);
  exact(root, ["version", "policies"]);
  if (root.version !== 1 || !Array.isArray(root.policies)) invalid();
  return new AssetInspectionPolicyRegistry(root.policies.map(parsePolicy));
}

function parsePolicy(value: unknown): ScopedPolicy {
  const policy = record(value);
  exact(policy, ["siteRef", "policyRevisionRef", "purpose", "allowedDetectedMediaTypes",
    "scannerDefinitionRef", "scannerRevisionRef", "signatureRevisionRef", "contentSafetyRequired"]);
  const siteRef = identifier(policy.siteRef);
  const policyRevisionRef = identifier(policy.policyRevisionRef);
  const purpose = boundedText(policy.purpose, 1, 128);
  const scannerDefinitionRef = identifier(policy.scannerDefinitionRef);
  const scannerRevisionRef = identifier(policy.scannerRevisionRef);
  const signatureRevisionRef = identifier(policy.signatureRevisionRef);
  if (!Array.isArray(policy.allowedDetectedMediaTypes) ||
      policy.allowedDetectedMediaTypes.length < 1 || policy.allowedDetectedMediaTypes.length > 64 ||
      typeof policy.contentSafetyRequired !== "boolean") invalid();
  const allowedDetectedMediaTypes = policy.allowedDetectedMediaTypes.map(mediaType);
  if (new Set(allowedDetectedMediaTypes).size !== allowedDetectedMediaTypes.length) invalid();
  return Object.freeze({ siteRef, policyRevisionRef, purpose,
    allowedDetectedMediaTypes: Object.freeze(allowedDetectedMediaTypes), scannerDefinitionRef,
    scannerRevisionRef, signatureRevisionRef, contentSafetyRequired: policy.contentSafetyRequired });
}

function policyKey(siteRef: string, revision: string, purpose: string): string {
  return `${identifier(siteRef)}\0${identifier(revision)}\0${boundedText(purpose, 1, 128)}`;
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(value).length !== keys.length || Object.keys(value).some((key) => !keys.includes(key))) invalid();
}

function identifier(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/u.test(value)) invalid();
  return value;
}

function boundedText(value: unknown, minimum: number, maximum: number): string {
  if (typeof value !== "string" || value.length < minimum || value.length > maximum ||
      value.trim() !== value || hasControlCharacter(value)) invalid();
  return value;
}

function mediaType(value: unknown): string {
  const source = boundedText(value, 3, 192);
  const result = source.toLowerCase();
  if (source !== result) invalid();
  if (!/^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,127}$/u.test(result)) invalid();
  return result;
}

function invalid(): never { throw new Error("ASSET_INSPECTION_POLICY_REGISTRY_INVALID"); }

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const point = character.codePointAt(0) ?? 0;
    return point < 32 || point === 127;
  });
}
