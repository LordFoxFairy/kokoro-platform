// 平台内置默认模型目录（单一真源，ADR：模型/provider/绑定/标签权威归 kokoro-model）。
// 「内置默认 model 全功能共享」——对外统一 claude-code 门面，经 litellm 网关路由到内部真后端
// （dev=GLM/假模型，可在网关侧换后端而不动此声明）。任何环境（dev closure-up / 生产部署）都调
// seedBuiltinCatalog 取得一致的内置目录，编排层不再各自硬编码定义。
//
// 注意：这里只声明「平台内置默认」这一档；dev-only 的离线假模型（kokoro-dev-mock）属编排层
// dev 便利，不进平台内置目录（生产不该出现「Dev Mock」标签）。

import type { ModelService } from "../application/model-service.js";
import type { ModelLabel } from "../domain/model.js";

// 网关 provider 账号：litellm 传输，凭据只存 env 引用（明文不入库，ADR-010）。
const BUILTIN_PROVIDER = {
  provider: "litellm",
  key: "gateway",
  label: "Kokoro 网关",
  secretRef: "env:LITELLM_MASTER_KEY",
  transportKind: "litellm" as const,
};

// claude-code 门面绑定：featureKey=chat；gatewayModelName 与网关 model_name、label.key 三处对齐，
// billing resolve 按 labelKey=claude-code 命中此绑定后把 runtime.model 改写到网关。
const BUILTIN_BINDING = {
  modelName: "claude-code",
  displayName: "Claude Code（网关门面）",
  featureKey: "chat",
  labelKeys: ["claude-code"],
  inputModalities: ["text"],
  outputModalities: ["text"],
  transportKind: "litellm" as const,
  gatewayModelName: "claude-code",
};

// 用户可选目录项：key=可 resolve 的 labelKey=/models 候选 name；与 session 默认名对齐即 is_default。
const BUILTIN_LABEL = {
  key: "claude-code",
  displayName: "Kokoro 默认",
  featureKey: "chat",
  tier: "standard",
  description: "平台内置默认模型（claude-code 门面 → 网关）",
};

export const BUILTIN_CATALOG = {
  provider: BUILTIN_PROVIDER,
  binding: BUILTIN_BINDING,
  label: BUILTIN_LABEL,
} as const;

export interface BuiltinCatalogResult {
  providerAccountId: string;
  bindingId: string;
  label: ModelLabel;
}

// 幂等落地内置目录：ensure provider → ensure binding（拿 id）→ ensure label（回填 defaultBindingId）。
// 走 service 层（与运行时同一校验/契约），不裸写 prisma。重复调用只 upsert，不产生副本。
export async function seedBuiltinCatalog(service: ModelService): Promise<BuiltinCatalogResult> {
  const account = await service.ensureProviderAccount({ ...BUILTIN_PROVIDER });
  const binding = await service.ensureModelBinding({
    providerAccountId: account.id,
    modelName: BUILTIN_BINDING.modelName,
    displayName: BUILTIN_BINDING.displayName,
    featureKey: BUILTIN_BINDING.featureKey,
    labelKeys: [...BUILTIN_BINDING.labelKeys],
    inputModalities: [...BUILTIN_BINDING.inputModalities],
    outputModalities: [...BUILTIN_BINDING.outputModalities],
    transportKind: BUILTIN_BINDING.transportKind,
    gatewayModelName: BUILTIN_BINDING.gatewayModelName,
  });
  const label = await service.ensureModelLabel({
    key: BUILTIN_LABEL.key,
    displayName: BUILTIN_LABEL.displayName,
    featureKey: BUILTIN_LABEL.featureKey,
    tier: BUILTIN_LABEL.tier,
    description: BUILTIN_LABEL.description,
    defaultBindingId: binding.id,
  });
  return { providerAccountId: account.id, bindingId: binding.id, label };
}
