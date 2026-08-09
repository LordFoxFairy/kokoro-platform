import type { CanonicalizedModelInventory } from "./model-catalog.js";

export const DIRECT_MODEL_PROVIDER_SECRET_REF = "secret://platform/model-gateway/direct";

export interface DirectModelProviderIdentity {
  readonly providerKey: "direct";
  readonly accountKey: "primary";
  readonly provider: "openai-compatible";
}

export const DIRECT_MODEL_PROVIDER_IDENTITY: DirectModelProviderIdentity = Object.freeze({
  providerKey: "direct",
  accountKey: "primary",
  provider: "openai-compatible",
});

export function assertInventoryUsesDirectModelProviderIdentity(
  inventory: CanonicalizedModelInventory,
): void {
  const expected = DIRECT_MODEL_PROVIDER_IDENTITY;
  const directProviders = inventory.document.providers.filter(
    (provider) => provider.adapterKind === "direct",
  );
  const direct = directProviders[0];
  if (
    directProviders.length !== 1 ||
    direct === undefined ||
    direct.key !== expected.providerKey ||
    direct.accountKey !== expected.accountKey ||
    direct.provider !== expected.provider ||
    direct.secretRef !== DIRECT_MODEL_PROVIDER_SECRET_REF
  ) {
    throw new Error("MODEL_DIRECT_PROVIDER_IDENTITY_MISMATCH");
  }
}
