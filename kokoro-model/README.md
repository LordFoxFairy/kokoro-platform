# kokoro-model

模型配置、provider account、model binding、model label 和 fallback 策略模块。

## 当前职责

`kokoro-model` 是 Kokoro 内部模型可用性和展示的权威模块。它决定某个功能可以使用哪些 provider/model/binding，但不直接扣积分，也不复制 LiteLLM 的网关实现。

## DDD 结构

```text
src/domain/                 领域类型、repository contract
src/application/            模型配置用例
src/infrastructure/prisma/  Prisma repository 实现
src/interfaces/http/        HTTP API
src/interfaces/admin/       admin manifest
src/config/                 env 解析
src/module.ts               平台模块元数据
```

## 当前能力

```text
ProviderAccount
ModelBinding
ModelLabel
transportKind = litellm | direct | internal
gatewayModelName
provider priority/status/healthStatus
featureKey + labelKeys + priority
```

当前 HTTP 面：

```text
GET  /healthz
POST /provider-accounts/ensure
POST /model-bindings/ensure
GET  /model-bindings
```

## 下一步补齐

```text
provider account:
  主账号/兜底账号
  启用/停用
  secretRef，不存明文 secret
  health check 写入 healthStatus

model binding:
  按 featureKey 查询可用模型
  按 labelKeys 筛选
  fallback resolve API
  input/output modalities 校验

model label:
  defaultBindingId
  plan/tier 标签
  前端展示名和业务描述

admin:
  provider account 管理
  binding 管理
  label 管理
  health 状态展示
```

## 边界

- 不扣积分。
- 不写 LiteLLM 源码。
- 不直接判断用户余额。
- 不保存大体积 provider raw output。
