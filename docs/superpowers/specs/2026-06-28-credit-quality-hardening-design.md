# kokoro-credit 质量硬化设计

日期：2026-06-28
范围：仅 `kokoro-credit` 模块。作为其余平台模块（site/user/model/payment）质量硬化的标杆模式。
原则：**行为保持**，对标 CLAUDE.md TS 铁律；不新增业务能力（hold/capture/release、siteId 站点化属 P1，范围外）。

## 背景

扫描 5 个平台模块发现底子干净（零 `: any`、零 `@ts-ignore`），但有一致硬伤：

```text
1. 19 个 z.object 全部未显式 .strict()（默认 .strip() 静默吞未知字段）。
2. ~10 处 as 类型断言（credit 内 1 处：prisma-credit-repository.ts:191）。
3. 测试薄（credit 现有 4 个测试文件），缺极端边界矩阵，离 95% 覆盖远。
```

kokoro-credit 现状：`CreditService` 仅有 `ensureAccount` / `grantCredits` / `spendCredits`；2 个 HTTP 载荷 schema + 1 个 env schema；domain 类型干净；`assertCreditSpendAllowed` 已有单测。

## 目标与验收

```text
- 外部 HTTP 载荷 schema 显式 .strict()，未知字段被拒（400），不再静默吞。
- env schema 维持 strip（有意例外，带 WHY 注释）。
- credit 内 as cast 清零（或留必要边界并 1 行注释解释）。
- 边界测试矩阵补齐，credit 业务逻辑行/分支覆盖率 ≥ 95%，整体覆盖率不下滑。
- pnpm typecheck + lint 全绿；现有测试不回归。
- 业务行为不变（断言意图不被篡改）。
```

## 设计

### ① Zod 严格边界（输入防守）

`src/interfaces/http/schemas.ts`：

```text
ensureCreditAccountRequestSchema -> 末尾加 .strict()
creditMutationRequestSchema      -> 末尾加 .strict()
```

二者是浏览器/服务间不可信外部载荷，未知字段必须显式拒绝。`amountMicros` 已用 `z.string().regex(/^[1-9]\d*$/)`（正整数串，禁前导零/零/负数），保留。

`src/config/env.ts`：

```text
creditEnvSchema 保持默认 strip，不加 .strict()。
WHY 注释（≤1 行）：env 来自 process.env 超集，strict 会被 PATH/HOME 等无关变量拒绝。
```

确认 `routes.ts` 用 `.parse`，strict 抛出的 ZodError 映射为 400（沿用现有错误处理）。

### ② 消除 cast

`src/infrastructure/prisma/prisma-credit-repository.ts:191` 的 `defined()`：

```text
现：return value === undefined ? {} : ({ [key]: value } as Record<Key, Value>);
改：用 Partial<Record<Key, Value>> 返回类型 + 不依赖 cast 的构造，
    或显式 Record<string, Value> 贯通，使断言消失，行为完全不变。
```

### ③ 边界测试矩阵（→ 95% 覆盖）

单元（无 DB，`test/unit/`）——schema 与 policy：

```text
amountMicros 反例：'0' / '-1' / '' / 'abc' / '01'(前导零) / 极大串 / 含空白 / 非数字 -> 全部 parse 失败。
ownerKind：非法值 / 空 / 缺失。
reason：非法 enum / 缺失。
缺必填：accountId / idempotencyKey 缺失。
未知字段：多传一个键 -> .strict() 拒绝。
requestId：可选，缺省合法、空串非法。
assertCreditSpendAllowed：balance == amount(边界放行) / balance < amount(抛 InsufficientCreditError) / 零额 / 极大值。
```

集成（真 MySQL，`test/integration/`）——service + repository：

```text
幂等：同 idempotencyKey 连续 grant 两次 -> 余额只加一次、ledger 不重复。
幂等：同 idempotencyKey 连续 spend 两次 -> 余额只减一次。
余额不足：spend > balance -> InsufficientCreditError，余额不变。
正常闭环：ensureAccount -> grant -> spend，余额与 ledger 一致。
```

使用 `it.each` / `describe.each` 参数化边界矩阵。

### ④ 验证门槛

```text
pnpm --filter @kokoro/credit typecheck     # tsc --noEmit 全绿
pnpm --filter @kokoro/credit lint          # eslint 全绿
pnpm --filter @kokoro/credit test          # unit 全绿
pnpm --filter @kokoro/credit test:integration   # 需本地 MySQL；起 docker DB，起不了则明说并只交 unit+typecheck+lint 证据
覆盖率：credit src 行/分支 ≥ 95%（vitest --coverage）
```

## 边界与风险

```text
- env schema 是 strip 的有意例外，不可误改成 strict（会启动即崩）。
- 消 cast 不得改变 defined() 的运行时行为（仅类型层）。
- 集成测试依赖真实 DB；环境无 DB 时如实标注未验，绝不 skip 掩盖。
- 不在共享库跑 root db:dev；如需新 migration 用子仓 scratch DB（本次预计不需 migration）。
```

## 范围外

```text
hold / capture / release（P1）、siteId 站点化、其余 4 模块的硬化（标杆定稿后另起）。
```
