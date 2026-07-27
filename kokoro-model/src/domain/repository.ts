import type {
  ModelBinding,
  ModelBindingStatus,
  ModelLabel,
  ModelLabelStatus,
  ModelTransportKind,
  ProviderAccount,
  ProviderAccountStatus,
  SiteModelPolicy,
  SiteModelPolicyStatus,
} from "./model.js";
import type { DeleteInput, ListOptions, RestoreInput } from "./model-lifecycle.js";

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
  // 必填：站点隔离键，排除命中该站 hidden 策略的 binding。
  // WHY 不可选：可选等于「不传就不过滤」，调用方只要省略即可绕过该站的模型隐藏策略（fail-open）。
  // 必填后类型系统在每个 callsite 强制给出归属站点，"无站点的 resolve" 不再可表达。
  siteId: string;
}

// 运行时目录（session 消费）。与 ResolveModelInput 同样必填 siteId，且必须是同一个值：
// 目录和 resolve 对「该站隐藏了哪些 label」必须给出一致答案，否则用户能选中一个选不动的模型。
// 与 listModelLabels() 的区别是信任面不同：那个是 admin 运维面，按设计看得到全部 label；
// 这个是站点用户面，只能看到该站允许的部分。
export interface ListSiteModelCatalogInput {
  siteId: string;
  featureKey?: string | undefined;
}

export interface EnsureModelLabelInput {
  key: string;
  displayName: string;
  description?: string | null | undefined;
  featureKey: string;
  tier?: string | null | undefined;
  defaultBindingId?: string | null | undefined;
  status?: ModelLabelStatus | undefined;
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
  listProviderAccounts(options?: ListOptions): Promise<ProviderAccount[]>;
  listAllModelBindings(options?: ListOptions): Promise<ModelBinding[]>;
  // admin 运维面：不按站点过滤。
  listModelLabels(): Promise<ModelLabel[]>;
  // 站点用户面：只出该站未隐藏的 active label。
  listSiteModelCatalog(input: ListSiteModelCatalogInput): Promise<ModelLabel[]>;
  ensureModelLabel(input: EnsureModelLabelInput): Promise<ModelLabel>;
  setProviderAccountStatus(
    id: string,
    status: ProviderAccountStatus,
  ): Promise<ProviderAccount | null>;
  setModelBindingStatus(id: string, status: ModelBindingStatus): Promise<ModelBinding | null>;
  deleteProviderAccount(input: DeleteInput): Promise<ProviderAccount>;
  restoreProviderAccount(input: RestoreInput): Promise<ProviderAccount>;
  deleteModelBinding(input: DeleteInput): Promise<ModelBinding>;
  restoreModelBinding(input: RestoreInput): Promise<ModelBinding>;
  upsertSiteModelPolicy(input: UpsertSiteModelPolicyInput): Promise<SiteModelPolicy>;
  listSiteModelPolicies(siteId?: string | undefined): Promise<SiteModelPolicy[]>;
}
