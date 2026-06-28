# 04 model + agent + session + artifact 站点上下文

本文定义模型、agent、session、job、artifact 如何在多站点下复用能力但隔离数据。

## 核心判断

```text
ProviderAccount 可以平台复用。
ModelBinding 可以平台复用。
SiteModelPolicy 控制站点可见性。
agent/session/job/artifact 必须 site scoped。
```

## kokoro-model

### 平台复用层

```text
ProviderAccount
  provider
  key
  secretRef
  transportKind = litellm | direct | internal
  priority
  healthStatus
  status

ModelBinding
  providerAccountId
  provider
  modelName
  displayName
  featureKey
  labelKeys
  inputModalities
  outputModalities
  transportKind
  gatewayModelName
  priority
  status
```

这些可以平台统一管理，避免每个站点重复配置 provider secret。

### 站点可见性层

```text
SiteModelPolicy
  siteId
  appKey
  surface
  capabilityKey
  modelBindingId
  labelKey
  status
  priority
  fallbackGroup
  defaultForCapability
```

规则：

- 站点只能使用 SiteModelPolicy allow 的模型。
- 默认模型按 site + app + surface + capability 解析。
- provider 健康状态影响 fallback，但不能绕过站点 allowlist。
- 模型价格不在 model 模块，仍由 credit PricingRule 决定。

## agent/session 请求上下文

所有 agent run 必须带：

```text
siteId
appKey
surface
userId
workspaceId
capabilityKey
requestId
```

后续过程继承：

```text
conversationId
jobId
runId
toolCallId
modelBindingId
artifactId
```

禁止：

- agent 自己从 host 猜 site。
- agent 直接扣 credit。
- agent 直接读取其它站点 artifact。
- tool/subagent 丢失 SiteContext。

## 执行链路

```text
web/gateway
  -> resolve SiteContext
  -> session.create
  -> agent.run
  -> credit.quote
  -> credit.hold
  -> model.resolve(siteId, capabilityKey)
  -> provider/tool
  -> artifact.create
  -> credit.capture 或 credit.release
```

## session 模型草案

```text
Conversation
  siteId
  appKey
  surface
  workspaceId
  userId
  title
  status

Message
  siteId
  conversationId
  role
  content
  metadata

AgentRun
  siteId
  conversationId
  jobId
  capabilityKey
  status
  modelBindingId
  requestId

ToolCall
  siteId
  runId
  toolKey
  status
  input
  output
```

## job 模型草案

```text
Job
  siteId
  appKey
  surface
  capabilityKey
  workspaceId
  userId
  status = queued | running | succeeded | failed | canceled
  idempotencyKey
  requestId

JobStep
  siteId
  jobId
  stepKey
  status
  provider
  modelBindingId
  startedAt
  finishedAt
```

## artifact 模型草案

```text
Project
  siteId
  workspaceId
  appKey
  name
  status

Artifact
  siteId
  workspaceId
  projectId
  appKey
  artifactType = audio | video | image | code | document
  visibility = private | unlisted | public
  status
  sourceJobId

Asset
  siteId
  artifactId
  storageKey
  mimeType
  sizeBytes
  checksum
```

公开产物必须保留 siteId，用于 SEO、权限和删除。

## studio 与 general

不要做两套计费系统。用 `surface` 和 `capabilityKey` 区分：

```text
general.chat.message
general.music.generate
music.studio.generate
music.studio.extend
video.studio.generate
image.studio.generate
code.agent.run
```

同一个 provider/model 可以被 general 和 studio 使用，但通过：

```text
SiteModelPolicy
PricingRule
EntitlementGrant
```

分别控制可见性、价格和权益。

## 风险

- SiteContext 丢失会导致任务写入错误站点。
- 模型 fallback 如果不带 siteId，可能调用站点未授权模型。
- artifact 如果不带 siteId，公开案例和白标数据会串。
- agent 如果绕过 credit，会产生账本缺口。

## 验收标准

- music job 无法写入 video workspace。
- SiteModelPolicy 未授权的模型无法 resolve。
- tool call 和 subagent run 都保留 siteId。
- artifact 查询默认按 siteId + workspaceId。
- public artifact URL 只在所属 site 的 canonical host 下生成。
