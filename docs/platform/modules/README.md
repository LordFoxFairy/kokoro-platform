# Platform 模块入口

当前 Platform 业务 owner 位于根 `src/modules/`，共享一套 PostgreSQL migration authority。修改前先读对应目录的 `INDEX.md`：

- `src/modules/site`：Site lifecycle、publication、provisioning 与 runtime effects。
- `src/modules/identity`：身份、membership、security management 与 namespace allocation。
- `src/modules/model-control`、`src/modules/model-gateway`：模型目录、Site policy 与 provider effects。
- `src/modules/credit`、`src/modules/commerce`：usage/credit authority 与购买、兑换、履约。
- `src/modules/admin-control`、`src/modules/admission`、`src/modules/authorization`：privileged control、Admission 与授权。
- `src/modules/artifact`、`src/modules/media`、`src/modules/memory`：产物、媒体执行与 Product Memory。
- `src/modules/product-catalog`、`src/modules/policy`、`src/modules/hub`：产品发布、策略与 Hub projection。
- `kokoro-hub`：独立 Hub HTTP package；`kokoro-platform-kit`：无业务状态的共享 runtime library。

当前边界以根 `INDEX.md`、各模块 `INDEX.md` 和 `docs/platform/deployment-topology.md` 为准。
