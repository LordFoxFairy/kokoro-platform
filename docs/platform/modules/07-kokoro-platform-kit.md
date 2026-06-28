# kokoro-platform-kit 技术方案

## 定位

`kokoro-platform-kit` 是无业务状态的基础工具包。它服务平台子仓，但不能成为隐藏业务模块。

## 可以拥有

```text
admin manifest schema
统一 HTTP response/error
startHttpServer helper
amount/credit micros 解析
request id helper
SiteContext 类型和 header parse/serialize，后续可加
```

## 禁止拥有

```text
业务 service
Prisma client
数据库 schema
用户/积分/支付/模型/site 的领域逻辑
远程服务 client 的复杂实现
业务常量大全
```

## 当前能力

```text
src/admin/manifest-schema.ts
src/domain/amount.ts
src/http/responses.ts
src/http/start-server.ts
```

测试：

```text
test/admin-manifest-schema.test.ts
test/amount.test.ts
test/http.test.ts
```

## 依赖方向

允许：

```text
kokoro-site/user/model/credit/payment -> kokoro-platform-kit
```

禁止：

```text
kokoro-platform-kit -> kokoro-site/user/model/credit/payment
```

## 后续任务

可以补：

```text
SiteContext type
x-kokoro-site-id 等 header 常量
parseSiteContextFromHeaders
serializeSiteContextToHeaders
assertRequiredSiteContext
```

不能补：

```text
domain -> site 解析
site policy 判断
credit quote
payment provider client
model resolve
```

## 验收

`kokoro-platform-kit` 的每个导出都必须满足：

```text
不查库
不调用业务服务
不持有业务状态
不决定业务策略
```
