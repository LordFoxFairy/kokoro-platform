# Multi-site 边界

`siteId` 是 Platform 业务数据的隔离边界。每个请求必须由可信边界解析 Site 和主体事实；业务模块不从浏览器 header 自行推导权威。

当前 owner 入口：

- `src/modules/site/INDEX.md`：Site identity、immutable release、activation 与 traffic-stop lifecycle。
- `src/modules/identity/INDEX.md`：账号、认证、membership、security management 与 namespace allocation。
- `src/modules/commerce/INDEX.md` 与 `src/modules/credit/INDEX.md`：购买、兑换、履约、usage 与 credit authority。
- `src/modules/model-control/INDEX.md` 与 `src/modules/model-gateway/INDEX.md`：模型发布、Site policy 与 provider effects。
- `src/modules/product-catalog/INDEX.md` 与 `src/modules/policy/INDEX.md`：不可变产品定义与策略权威。

跨 Site 共享必须由明确 owner contract 授权，不得通过缺失 `siteId`、默认 Site 或未分区读取实现。部署与运行时边界见 `docs/platform/deployment-topology.md`。
