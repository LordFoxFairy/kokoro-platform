# kokoro-litellm 技术方案

## 定位

`kokoro-litellm` 是 LiteLLM 网关的部署和配置接入目录，不是 Kokoro 自己的模型业务权威。

## 职责

拥有：

- LiteLLM proxy 配置样例
- healthcheck 脚本
- docker compose 样例
- 与 `kokoro-model` 的映射约定

不拥有：

- model catalog
- model label
- provider account 业务状态
- credit ledger
- user/team 权限

## 与 kokoro-model 的关系

`kokoro-model` 保存：

```text
ProviderAccount
ModelBinding
ModelLabel
featureKey
labelKeys
transportKind
gatewayModelName
```

当 `transportKind = litellm` 时：

```text
ModelBinding.gatewayModelName -> LiteLLM model_name
```

LiteLLM 负责：

- provider 请求代理
- virtual keys
- rate limit
- budget guard
- 部分 spend tracking
- provider retry/fallback

Kokoro 负责：

- 用户/站点权限
- 模型可见性
- 套餐权益
- 积分扣费
- 审计

## 配置原则

不要修改 LiteLLM 源码。

优先使用：

- LiteLLM proxy
- config yaml
- virtual keys
- model aliases
- callbacks/hooks，后续按需

Kokoro 只保存自己的映射关系和审计状态。

## 部署

`kokoro-litellm` 可以独立部署，也可以作为外部服务由环境提供。

平台 registry 中状态为：

```text
status: external
kind: gateway
```

## 后续任务

- 明确 LiteLLM virtual key 与 site/team 的映射策略。
- 为每个 site/team 设置 budget guard。
- 将 LiteLLM spend tracking 与 Kokoro usage record 对账。
- 设计失败重试和 credit hold 的一致性策略。

## 风险

不要把 LiteLLM 当成 Kokoro 的账本。LiteLLM 的 spend/budget 可以做护栏，但最终用户积分、套餐权益和账务审计在 `kokoro-credit`。
