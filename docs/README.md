# kokoro-platform 文档

这个目录只放 `kokoro-platform` 父仓和平台模块自己的长期文档。

## 放这里

- platform 父仓职责、模块注册、部署拓扑、统一验证和 admin 入口。
- kokoro-site / kokoro-user / kokoro-model / kokoro-credit / kokoro-payment /
  kokoro-litellm / platform-kit 的模块方案。
- 平台域内部的 multi-site、tenant、admin、tech hardening、module roadmap。

## 不放这里

- agent/session/web 的实现主权文档。
- 根仓 handbook 级跨仓规则全文。
- 临时调研材料、外部参考来源路径、截图和探索草稿。

这些内容分别属于根仓 `../docs/`、对应子仓的 `docs/`，或本仓被忽略的临时目录。

## 入口

- [platform 总路线](./platform/subrepo-capability-roadmap.md)
- [platform 部署拓扑](./platform/deployment-topology.md)
- [platform 模块交接](./platform/modules/README.md)
- [multi-site 分册](./platform/multi-site/README.md)

## 与 namespace 的关系

platform 可以管理 site、user、team、membership、model、credit、payment 和 future
capability control plane。GA/runtime 隔离仍以根仓 handbook 的 `namespace` 规则为准：
platform/web/session 选择并校验 namespace，agent 只消费 namespace。
