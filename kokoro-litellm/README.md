# kokoro-litellm

Kokoro 平台的 LLM 网关部署与配置层。

这里不是 LiteLLM 源码仓库，不 fork、不 submodule、不 vendoring LiteLLM。
本仓库只放官方 LiteLLM Docker image / pip package 的部署配置、环境模板、接入说明和健康检查。

## 边界与契约

- 负责：`docker-compose`、`.env`、LiteLLM config、health check、接入说明
- 不负责：LiteLLM 源码、SDK 改造、协议重写、业务模型绑定逻辑、积分扣费

- `kokoro-model` 负责 model binding
- `binding.transportKind = litellm`
- `binding.gatewayModelName` 映射到 LiteLLM 的 `model_name`
- `kokoro-agent` 调用本网关 endpoint，并把 usage 上报给 `kokoro-credit`

完整跨仓契约见 [CONTRACT.md](./CONTRACT.md)。

## 快速开始

1. 复制 `.env.example` 为 `.env`，填入 `LITELLM_MASTER_KEY` 和 provider key。
2. 编辑 `config/litellm.config.example.yaml`
3. 用 `docker-compose.example.yml` 启动 LiteLLM：

```bash
LITELLM_ENV_FILE=.env docker compose -f docker-compose.example.yml up
```

4. 运行 `bash scripts/healthcheck.sh`
5. 运行 `bash scripts/smoke-openai-compatible.sh`

默认对外暴露 `http://127.0.0.1:4000/v1`，兼容 OpenAI 客户端。

## 配置原则

`config/litellm.config.example.yaml` 里的 `model_name` 必须能被 `kokoro-model` 的 `gatewayModelName` 引用。例如：

```text
kokoro-model ModelBinding.gatewayModelName = kokoro-openai-gpt-4o-mini
LiteLLM model_list[].model_name          = kokoro-openai-gpt-4o-mini
```

配置文件只引用环境变量，不提交真实 provider key。

不要在 LiteLLM config 中写入：

- 用户、team、site 业务权限。
- 套餐权益。
- credit pricing 或 ledger 规则。
- 非 LLM provider 的 direct adapter 逻辑。

## 验证

静态检查：

```bash
sh -n scripts/healthcheck.sh
sh -n scripts/smoke-openai-compatible.sh
docker compose -f docker-compose.example.yml config
```

运行检查：

```bash
bash scripts/healthcheck.sh
bash scripts/smoke-openai-compatible.sh
```

`healthcheck.sh` 只确认 liveliness；`smoke-openai-compatible.sh` 会用 `LITELLM_MASTER_KEY` 调 `/v1/models`，验证 OpenAI-compatible surface。

## 镜像策略

使用官方 LiteLLM 镜像 `ghcr.io/berriai/litellm:main-stable`。

本地开发可以继续用 stable tag。生产环境必须通过 `LITELLM_IMAGE` 覆盖到明确 tag 或 digest，不维护 LiteLLM 源码。

## 健康检查

```bash
curl -fsS http://127.0.0.1:4000/health/liveliness
```

或者：

```bash
bash scripts/healthcheck.sh
```

可通过以下环境变量覆盖：

```text
LITELLM_HEALTH_URL
LITELLM_SCHEME
LITELLM_HOST
LITELLM_PORT
LITELLM_HEALTH_PATH
```
