import type { ModelBinding, ModelLabel, ModelTransportKind, ProviderAccount } from "./model.js";

export interface EnsureProviderAccountInput {
  provider: string;
  key: string;
  label: string;
  secretRef: string;
  priority?: number | undefined;
  transportKind: ModelTransportKind;
}

export interface EnsureModelBindingInput {
  providerAccountId: string;
  modelName: string;
  displayName: string;
  featureKey: string;
  labelKeys: string[];
  inputModalities: string[];
  outputModalities: string[];
  transportKind: ModelTransportKind;
  gatewayModelName?: string | undefined;
  contextWindow?: number | undefined;
  priority?: number | undefined;
}

export interface ListModelBindingsFilter {
  featureKey?: string | undefined;
  labelKey?: string | undefined;
}

export interface ResolveModelInput {
  featureKey: string;
  labelKey?: string | undefined;
  transportKind?: ModelTransportKind | undefined;
}

export interface ModelRepository {
  ensureProviderAccount(input: EnsureProviderAccountInput): Promise<ProviderAccount>;
  ensureModelBinding(input: EnsureModelBindingInput): Promise<ModelBinding>;
  listModelBindings(filter: ListModelBindingsFilter): Promise<ModelBinding[]>;
  resolveModelBindings(input: ResolveModelInput): Promise<ModelBinding[]>;
  listProviderAccounts(): Promise<ProviderAccount[]>;
  listAllModelBindings(): Promise<ModelBinding[]>;
  listModelLabels(): Promise<ModelLabel[]>;
}
