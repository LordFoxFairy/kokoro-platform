import { describe, expect, it } from "vitest";
import { ModelService } from "../../src/application/model-service.js";
import { BUILTIN_CATALOG, seedBuiltinCatalog } from "../../src/interfaces/cli/builtin-catalog.js";
import type { ModelBinding, ModelLabel, ProviderAccount } from "../../src/domain/model.js";
import type {
  EnsureModelBindingInput,
  EnsureModelLabelInput,
  EnsureProviderAccountInput,
  ModelRepository,
} from "../../src/domain/repository.js";

const NOW = new Date(0);

// 捕获式 repo：只实现 seedBuiltinCatalog 触达的三个 ensure，回定值 + 记入参。
function captureRepo(captured: {
  provider?: EnsureProviderAccountInput;
  binding?: EnsureModelBindingInput;
  label?: EnsureModelLabelInput;
}): ModelRepository {
  const account: ProviderAccount = {
    id: "pa_builtin",
    provider: "litellm",
    key: "gateway",
    label: "Kokoro 网关",
    secretRef: "env:LITELLM_MASTER_KEY",
    status: "active",
    priority: 100,
    transportKind: "litellm",
    healthStatus: "unknown",
    deletedAt: null,
    deletedBy: null,
    deleteReason: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
  const binding: ModelBinding = {
    id: "mb_builtin",
    providerAccountId: "pa_builtin",
    provider: "litellm",
    modelName: "claude-code",
    displayName: "Claude Code（网关门面）",
    featureKey: "chat",
    labelKeys: ["claude-code"],
    inputModalities: ["text"],
    outputModalities: ["text"],
    transportKind: "litellm",
    gatewayModelName: "claude-code",
    contextWindow: null,
    priority: 100,
    status: "active",
    deletedAt: null,
    deletedBy: null,
    deleteReason: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
  const label: ModelLabel = {
    id: "ml_builtin",
    key: "claude-code",
    displayName: "Kokoro 默认",
    description: "平台内置默认模型（claude-code 门面 → 网关）",
    featureKey: "chat",
    tier: "standard",
    defaultBindingId: "mb_builtin",
    status: "active",
    createdAt: NOW,
    updatedAt: NOW,
  };
  return {
    ensureProviderAccount: async (input) => {
      captured.provider = input;
      return account;
    },
    ensureModelBinding: async (input) => {
      captured.binding = input;
      return binding;
    },
    ensureModelLabel: async (input) => {
      captured.label = input;
      return label;
    },
    listModelBindings: async () => [],
    resolveModelBindings: async () => [],
    listProviderAccounts: async () => [account],
    listAllModelBindings: async () => [binding],
    listModelLabels: async () => [label],
    setProviderAccountStatus: async () => account,
    setModelBindingStatus: async () => binding,
    deleteProviderAccount: async () => account,
    restoreProviderAccount: async () => account,
    deleteModelBinding: async () => binding,
    restoreModelBinding: async () => binding,
    upsertSiteModelPolicy: async () => {
      throw new Error("not used");
    },
    listSiteModelPolicies: async () => [],
  };
}

describe("seedBuiltinCatalog", () => {
  it("按 provider→binding→label 顺序落地，label.defaultBindingId 回填 binding.id", async () => {
    const captured: Parameters<typeof captureRepo>[0] = {};
    const service = new ModelService(captureRepo(captured));
    const result = await seedBuiltinCatalog(service);

    // provider 入参 = 声明的网关档（凭据只 env 引用）。
    expect(captured.provider).toEqual(BUILTIN_CATALOG.provider);
    // binding 挂在 provider id 上，labelKeys/gatewayModelName 对齐门面键。
    expect(captured.binding?.providerAccountId).toBe("pa_builtin");
    expect(captured.binding?.labelKeys).toEqual(["claude-code"]);
    expect(captured.binding?.gatewayModelName).toBe("claude-code");
    // label.key = 可 resolve 的 labelKey；defaultBindingId 回填上一步 binding id。
    expect(captured.label?.key).toBe("claude-code");
    expect(captured.label?.defaultBindingId).toBe("mb_builtin");
    expect(result.bindingId).toBe("mb_builtin");
    expect(result.label.key).toBe("claude-code");
  });

  it("内置声明自洽：label.key ∈ binding.labelKeys（否则 /models 可用性过滤会剔除内置默认）", () => {
    expect(BUILTIN_CATALOG.binding.labelKeys).toContain(BUILTIN_CATALOG.label.key);
    // gatewayModelName 与 label.key 同名 = 与网关 model_name 三处对齐。
    expect(BUILTIN_CATALOG.binding.gatewayModelName).toBe(BUILTIN_CATALOG.label.key);
  });
});
