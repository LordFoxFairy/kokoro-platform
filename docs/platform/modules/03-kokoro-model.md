# kokoro-model 技术方案

## 定位

`kokoro-model` 是模型配置、provider account、model binding、label、能力可见性和兜底策略的权威模块。

## 职责

拥有：

- ProviderAccount
- ModelBinding
- ModelLabel
- SiteModelPolicy
- provider priority
- provider health status
- LiteLLM/direct/internal 的 transport 标记

不拥有：

- 用户权限本身
- 积分账本
- 支付订单
- 生成产物
- LiteLLM 网关运行态

## 当前模型

已实现：

```text
model_provider_accounts
model_bindings
model_labels
```

关键字段：

```text
ProviderAccount:
  provider, key, label, secretRef, status, priority, transportKind, healthStatus

ModelBinding:
  providerAccountId, provider, modelName, displayName, featureKey,
  labelKeys, inputModalities, outputModalities, transportKind,
  gatewayModelName, contextWindow, priority, status

ModelLabel:
  key, displayName, description, featureKey, tier, defaultBindingId, status
```

当前接口：

```text
GET  /healthz
POST /provider-accounts/ensure
POST /model-bindings/ensure
GET  /model-bindings
```

## 站点化策略

ProviderAccount 可以平台复用，但模型可见性必须站点化。

新增规划：

```text
SiteModelPolicy:
  siteId
  featureKey
  labelKey?
  modelBindingId?
  status
  priority
  quotaClass?
  metadata
```

查询路径：

```text
siteId + featureKey + labelKeys + user/team entitlement
  -> available model bindings
  -> priority / fallback
  -> transportKind
  -> gatewayModelName or direct adapter
```

## LiteLLM 关系

LiteLLM 是大模型网关，不是业务模型权威。

`transportKind`：

```text
litellm
  LLM 走 LiteLLM proxy。

direct
  music/video/image 等 provider 直接由 adapter 调用。

internal
  内部模型或自托管服务。
```

同名模型通常由 provider + modelName 区分。展示层可以用 labelKey 聚合，但运行时必须解析到具体 binding。

## Admin

admin manifest 管理：

```text
provider accounts
model bindings
model labels
health status
```

后续增加：

```text
site model policies
provider fallback order
health check logs
```

## 部署

服务名：

```text
kokoro-model
```

端口：

```text
4221
```

环境变量：

```text
DATABASE_URL_MODEL
KOKORO_MODEL_PORT
KOKORO_MODEL_BASE_URL
KOKORO_SITE_BASE_URL
```

## 测试

必须补：

- disabled provider 不参与 resolve。
- 同 featureKey 按 site policy 返回不同 model list。
- fallback provider 按 priority 生效。
- `litellm` binding 必须有 gatewayModelName。
- `direct` binding 不强制 gatewayModelName。

## 风险

不要把价格放进 model。model 最多提供成本参考和能力标签，最终扣费规则在 credit。
