export type ModelTransportKind = "litellm" | "direct" | "internal";
export type ProviderAccountStatus = "active" | "disabled";
export type ProviderHealthStatus = "unknown" | "healthy" | "degraded" | "down";
export type ModelBindingStatus = "active" | "disabled";
export type ModelLabelStatus = "active" | "disabled";
export type SiteModelPolicyStatus = "visible" | "hidden";

export interface ProviderAccount {
  id: string;
  provider: string;
  key: string;
  label: string;
  secretRef: string;
  status: ProviderAccountStatus;
  priority: number;
  transportKind: ModelTransportKind;
  healthStatus: ProviderHealthStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface ModelBinding {
  id: string;
  providerAccountId: string;
  provider: string;
  modelName: string;
  displayName: string;
  featureKey: string;
  labelKeys: string[];
  inputModalities: string[];
  outputModalities: string[];
  transportKind: ModelTransportKind;
  gatewayModelName: string | null;
  contextWindow: number | null;
  priority: number;
  status: ModelBindingStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface ModelLabel {
  id: string;
  key: string;
  displayName: string;
  description: string | null;
  featureKey: string;
  tier: string | null;
  defaultBindingId: string | null;
  status: ModelLabelStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface SiteModelPolicy {
  id: string;
  siteId: string;
  labelKey: string;
  status: SiteModelPolicyStatus;
  createdAt: Date;
  updatedAt: Date;
}
