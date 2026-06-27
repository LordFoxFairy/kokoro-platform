# kokoro-litellm

Kokoro 平台的 LLM 网关部署与配置层。

这里不是 LiteLLM 源码仓库，不 fork、不 submodule、不 vendoring LiteLLM。
本仓库只放官方 LiteLLM Docker image / pip package 的部署配置、环境模板、接入说明和健康检查。

## 边界

- 负责：`docker-compose`、`.env`、LiteLLM config、health check、接入说明
- 不负责：LiteLLM 源码、SDK 改造、协议重写、业务模型绑定逻辑、积分扣费

## 角色

- `kokoro-model` 负责 model binding
- `binding.transportKind = litellm`
- `binding.gatewayModelName` 映射到 LiteLLM 的 `model_name`
- `kokoro-agent` 调用本网关 endpoint，并把 usage 上报给 `kokoro-credit`

## 快速开始

1. 复制 `.env.example` 为 `.env`
2. 编辑 `config/litellm.config.example.yaml`
3. 用 `docker-compose.example.yml` 启动 LiteLLM
4. 运行 `bash scripts/healthcheck.sh`

默认对外暴露 `http://127.0.0.1:4000/v1`，兼容 OpenAI 客户端。

## 官方镜像

使用官方 LiteLLM 镜像 `ghcr.io/berriai/litellm:main-stable`。

如果后续要锁版本，只改 image tag，不维护 LiteLLM 源码。

## 健康检查

```bash
curl -fsS http://127.0.0.1:4000/health/liveliness
```

或者：

```bash
bash scripts/healthcheck.sh
```
