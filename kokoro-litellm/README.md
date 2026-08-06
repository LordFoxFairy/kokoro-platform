# kokoro-litellm

Kokoro Platform Model Gateway 的可选 LiteLLM adapter 部署与配置层。

这里不是 LiteLLM 源码仓库，不 fork、不 submodule、不 vendoring LiteLLM。
本仓库只放官方 LiteLLM Docker image / pip package 的部署配置、环境模板、接入说明和健康检查。

## 边界与契约

- 负责：`docker-compose`、`.env`、LiteLLM config、health check、接入说明
- 不负责：LiteLLM 源码、SDK 改造、协议重写、业务模型绑定逻辑、积分扣费

- Platform Model Control 发布 `adapterKind: direct | litellm` 和稳定 `gatewayModel`。
- Admission 将选中的 adapter 与模型别名冻结到执行授权，调用期间不重新选路。
- Agent 只调用 Platform Model Gateway，不直连 LiteLLM，也不拥有 usage/credit settlement。
- 只有 `adapterKind: litellm` 的授权使用本目录；Direct 是默认生产装配且不加载此配置。

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

默认在容器网络暴露 `https://litellm:4000/v1`，宿主通过 `https://localhost:4000/v1` 访问。
`secrets/` 必须提供 `server.key`、`server.crt` 与 `ca.crt`，示例证书 SAN 包含 `litellm` 和
`localhost`；调用方使用同一 CA 验证连接。

## 配置原则

`config/litellm.config.example.yaml` 里的 `model_name` 必须与 Model Control 发布的
`gatewayModel` 一致。例如：

```text
Model Control gatewayModel      = kokoro-openai-gpt-4o-mini
LiteLLM model_list[].model_name = kokoro-openai-gpt-4o-mini
```

配置文件只引用环境变量，不提交真实 provider key。

不要在 LiteLLM config 中写入：

- 用户、team、site 业务权限。
- 套餐权益。
- credit pricing 或 ledger 规则。
- Platform Model Gateway 的 Direct adapter 逻辑。
- adapter fallback 或跨授权模型改写。

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
curl --cacert ./secrets/ca.crt -fsS https://localhost:4000/health/liveliness
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
LITELLM_CA_CERT_FILE
```
