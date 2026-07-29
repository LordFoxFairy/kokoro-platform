const indirectSecretReference = /^(?:secret|vault|env):\/\/[A-Za-z0-9._:/-]+$/u;

/**
 * Legacy export is a trust-boundary conversion, not a secret migration tool.
 * A value that is not already an indirect reference must be quarantined by an
 * operator; treating an environment-variable name or plaintext as a ref would
 * silently publish an unusable (and potentially leaked) credential identity.
 */
export function parseLegacySecretReference(value: unknown): string {
  if (typeof value !== "string" || !indirectSecretReference.test(value))
    throw new Error("LEGACY_PROVIDER_SECRET_REFERENCE_INVALID");
  return value;
}
