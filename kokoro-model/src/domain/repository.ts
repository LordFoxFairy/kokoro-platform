import type {
  ModelBinding,
  ModelBindingStatus,
  ModelLabel,
  ModelTransportKind,
  ProviderAccount,
  ProviderAccountStatus,
  SiteModelPolicy,
  SiteModelPolicyStatus,
} from "./model.js";

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
  // 缺省 = 不按站过滤；提供时排除命中该站 hidden 策略的 binding。
  siteId?: string | undefined;
}

export interface UpsertSiteModelPolicyInput {
  siteId: string;
  labelKey: string;
  status: SiteModelPolicyStatus;
}

export interface ModelRepository {
  ensureProviderAccount(input: EnsureProviderAccountInput): Promise<ProviderAccount>;
  ensureModelBinding(input: EnsureModelBindingInput): Promise<ModelBinding>;
  listModelBindings(filter: ListModelBindingsFilter): Promise<ModelBinding[]>;
  resolveModelBindings(input: ResolveModelInput): Promise<ModelBinding[]>;
  listProviderAccounts(): Promise<ProviderAccount[]>;
  listAllModelBindings(): Promise<ModelBinding[]>;
  listModelLabels(): Promise<ModelLabel[]>;
  setProviderAccountStatus(
    id: string,
    status: ProviderAccountStatus,
  ): Promise<ProviderAccount | null>;
  setModelBindingStatus(id: string, status: ModelBindingStatus): Promise<ModelBinding | null>;
  upsertSiteModelPolicy(input: UpsertSiteModelPolicyInput): Promise<SiteModelPolicy>;
  listSiteModelPolicies(siteId?: string | undefined): Promise<SiteModelPolicy[]>;
}
