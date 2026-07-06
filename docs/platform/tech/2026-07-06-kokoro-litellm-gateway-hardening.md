# kokoro-litellm 网关配置完善技术方案

> 状态：方案锁定稿。本文只覆盖 `kokoro-litellm`，它是 LiteLLM 官方网关的部署配置目录，不是 Kokoro 业务服务子仓。

## 1. 为什么第六个做 litellm

`kokoro-model` 已经收束 model binding 生命周期，并强制 `transportKind=litellm` 时必须有 `gatewayModelName`。下一步需要把这个运行网关目录补成可交付配置边界，否则模型目录能解析出 gateway model，却没有清晰的网关部署、健康检查和调用契约。

选择 litellm 的理由：

- 它是 LLM provider 请求代理，不是模型业务权威；边界必须写清楚，避免把权限、套餐、扣费迁进网关。
- 它没有 Prisma schema、package、HTTP service 代码；不能为了“统一”强行加 DB lifecycle。
- 它承接 `kokoro-model.gatewayModelName -> LiteLLM model_name`，配置漂移会导致 runtime 调用失败。
- 它是典型成熟框架接入场景：使用官方镜像和配置文件，不 fork、不复制实现。

## 2. 范围

本轮只改：

- `kokoro-litellm/.env.example`
- `kokoro-litellm/README.md`
- `kokoro-litellm/CONTRACT.md`
- `kokoro-litellm/config/litellm.config.example.yaml`
- `kokoro-litellm/docker-compose.example.yml`
- `kokoro-litellm/scripts/*`
- 必要的 litellm 技术方案和执行计划文档。

不在本轮做：

- 不写 LiteLLM 源码。
- 不新增 Kokoro DB 表。
- 不新增 admin manifest。
- 不把 provider account、model binding、pricing、credit ledger 放进 LiteLLM。
- 不接真实生产密钥。

## 3. 当前取证

当前目录只有：

- `.env.example`
- `README.md`
- `config/litellm.config.example.yaml`
- `docker-compose.example.yml`
- `scripts/healthcheck.sh`

平台 registry 中 `litellm` 为：

- `status=external`
- `kind=gateway`
- `storage.primary=external`
- `ownsMigrations=false`
- `dependencies=["model"]`

这说明它是外部网关配置，不是 active business module。

## 4. 设计决策

### D1. 不加 DB lifecycle

`kokoro-litellm` 没有业务表，也不拥有 provider account 或 model binding。删除/恢复由 git 配置变更、镜像版本回滚和环境变量管理完成，不在这里造软删除模型。

理由：软删除是业务数据生命周期，不是静态配置目录的默认动作。对配置目录强行加 DB 表会制造第二套权威。

### D2. `kokoro-model` 是模型业务权威

唯一跨仓契约：

```text
ModelBinding.transportKind = litellm
ModelBinding.gatewayModelName = LiteLLM model_name
```

LiteLLM config 的 `model_list[].model_name` 必须能被 `kokoro-model` 的 binding 引用。

理由：模型展示、可见性、fallback、站点策略都在 model；LiteLLM 只代理 LLM 请求。

### D3. 网关只做 runtime guard，不做最终账本

LiteLLM 可承接：

- provider proxy
- virtual key
- rate limit
- budget guard
- provider retry/fallback
- OpenAI-compatible API surface

Kokoro 仍承接：

- user/team/site 权限
- model 可见性
- credit quote/hold/capture/spend
- usage record
- payment/refund 审计

理由：网关 spend tracking 可做护栏和对账信号，但最终积分资产和审计必须在 `kokoro-credit`。

### D4. 配置文件必须可读、可验证、不可含真实密钥

样例配置只允许：

- `os.environ/...` 引用环境变量。
- 明确的 `model_name` 示例。
- 与 `kokoro-model.gatewayModelName` 一致的命名说明。

不允许：

- 真实 API key。
- 站点/team/user 的业务授权写死在 yaml。
- 价格、积分、套餐策略写入 LiteLLM config。

理由：配置样例会被复制到本地和环境部署；必须默认安全，不能混入真实 secret 或业务授权。

### D5. 运行入口保持 shell + Docker Compose

保留成熟框架接入方式：

- Docker Compose example 启动官方镜像。
- `.env.example` 统一端口、host、health path、base URL、provider key。
- `scripts/healthcheck.sh` 做 liveliness 检查。
- 新增 smoke 脚本只验证 OpenAI-compatible `/v1/models` surface，不做业务调用。

理由：这个目录不需要 Node/Python package。引入 package manager 只会增加维护面。

### D6. 镜像版本策略

默认继续使用官方 stable tag，生产环境必须允许通过 `LITELLM_IMAGE` 覆盖到固定 digest/tag。

理由：本地开发需要简单启动，生产需要可重复部署。镜像版本不写死在代码里，由环境选择。

## 5. 核心链路

### A. 模型解析到网关

```text
runtime
  -> kokoro-model GET /model-bindings/resolve
  -> choose binding where transportKind=litellm
  -> call LiteLLM /v1/chat/completions with model=binding.gatewayModelName
```

理由：runtime 不直接猜 provider model；只消费 model 的解析结果。

### B. 扣费保护

```text
runtime
  -> kokoro-credit quote
  -> kokoro-credit hold
  -> LiteLLM call
  -> kokoro-credit capture/release + usage record
```

LiteLLM budget/rate limit 只作为额外护栏。

理由：跨服务没有分布式事务，credit hold/capture 是 Kokoro 的资产承诺链路。

### C. 健康检查

```text
scripts/healthcheck.sh
  -> LITELLM_HEALTH_URL 或 LITELLM_SCHEME/HOST/PORT/PATH
  -> curl -fsS
```

理由：本地、compose、CI 和部署平台可能有不同 host/path，脚本应通过 env 覆盖。

### D. Smoke 检查

```text
scripts/smoke-openai-compatible.sh
  -> GET /v1/models
  -> Authorization: Bearer $LITELLM_MASTER_KEY
```

理由：liveliness 只能说明服务活着；`/v1/models` 能说明 OpenAI-compatible surface 和 master key 基本可用。

## 6. 目录与文件命名

保留：

- `kokoro-litellm/.env.example`
- `kokoro-litellm/README.md`
- `kokoro-litellm/CONTRACT.md`
- `kokoro-litellm/config/litellm.config.example.yaml`
- `kokoro-litellm/docker-compose.example.yml`
- `kokoro-litellm/scripts/healthcheck.sh`
- `kokoro-litellm/scripts/smoke-openai-compatible.sh`

命名理由：

- 配置目录用官方常见命名：`config/`、`docker-compose.example.yml`、`.env.example`。
- shell 脚本用 kebab-case，和现有 `healthcheck.sh` 对齐。
- 不新增 Python 文件；这里没有 Python 业务逻辑或工具链。
- `CONTRACT.md` 独立承载跨仓约束，README 保持快速上手。

## 7. 验证策略

无 package gate。使用以下检查：

```bash
sh -n kokoro-litellm/scripts/healthcheck.sh
sh -n kokoro-litellm/scripts/smoke-openai-compatible.sh
docker compose -f kokoro-litellm/docker-compose.example.yml config
git diff --check
```

如果本地 LiteLLM 已启动，可选：

```bash
bash kokoro-litellm/scripts/healthcheck.sh
bash kokoro-litellm/scripts/smoke-openai-compatible.sh
```

不要求本轮启动真实 provider；样例配置不包含真实 key。

## 8. 风险

- 配置漂移：`gatewayModelName` 和 `model_name` 不一致会导致 runtime 调用失败。
- 权限漂移：把 site/team 授权写进 LiteLLM config 会绕过 Kokoro 业务权限。
- 账务漂移：依赖 LiteLLM spend tracking 扣费会绕过 `kokoro-credit` ledger。
- 版本漂移：默认 stable tag 适合本地，生产必须固定 image tag/digest。
