# kokoro-credit 质量硬化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `kokoro-credit` 对标 CLAUDE.md TS 铁律（严格校验、零 cast、边界测试矩阵、≥95% 覆盖），行为不变，作为其余平台模块的标杆。

**Architecture:** 在现有 DDD 分层（domain/application/infrastructure/interfaces）内做收敛：外部 HTTP 载荷 Zod schema 显式 `.strict()`；消除 infrastructure 层 1 处类型断言；补单元边界矩阵（schema/service/policy，无 DB）与集成幂等/余额不足用例（真 MySQL）；引入覆盖率工具并设 95% 阈值。

**Tech Stack:** TypeScript (ESM, NodeNext)、Zod、Fastify、Prisma(MySQL)、Vitest。

## Global Constraints

- 外部不可信载荷 schema 必须显式 `.strict()`（CLAUDE.md Zod 铁律）。
- env schema 例外：保持默认 strip，不加 strict（parse `process.env` 超集）。
- 零 `any` / 零 `cast` / 零 `@ts-ignore`（测试桩用完整类型对象，不用 `as`）。
- 不改变业务行为；不篡改现有测试断言意图。
- 不引入 InMemory fallback；集成测试连真实 DB；测试不得隐式 `skip`。
- 类型用 `z.infer` 推导；amountMicros 正整数串规则 `/^[1-9]\d*$/` 保留。
- credit src 行/分支覆盖率 ≥ 95%，整体不下滑。
- 工作目录：`kokoro-platform/kokoro-credit`（worktree 子模块，分支 `polish/credit-quality`）。命令用 `pnpm --filter @kokoro/credit <script>`。

---

### Task 1: HTTP 载荷 schema 严格化 + env 例外注释

**Files:**
- Modify: `kokoro-credit/src/interfaces/http/schemas.ts`
- Modify: `kokoro-credit/src/config/env.ts`
- Test: `kokoro-credit/test/unit/credit-schemas.test.ts` (create)

**Interfaces:**
- Consumes: 现有 `ensureCreditAccountRequestSchema`、`creditMutationRequestSchema`（导出不变）。
- Produces: 两 schema 行为变为拒绝未知字段；导出名/字段不变。

- [ ] **Step 1: 写失败测试**

```ts
// kokoro-credit/test/unit/credit-schemas.test.ts
import { describe, expect, it } from "vitest";
import {
  creditMutationRequestSchema,
  ensureCreditAccountRequestSchema,
} from "../../src/interfaces/http/schemas.js";

describe("credit HTTP schemas reject unknown fields", () => {
  it("ensureCreditAccountRequestSchema rejects extra keys", () => {
    expect(() =>
      ensureCreditAccountRequestSchema.parse({ ownerKind: "user", ownerId: "u1", extra: 1 }),
    ).toThrow();
  });

  it("creditMutationRequestSchema rejects extra keys", () => {
    expect(() =>
      creditMutationRequestSchema.parse({
        accountId: "a1",
        amountMicros: "100",
        idempotencyKey: "k1",
        reason: "subscription",
        bogus: true,
      }),
    ).toThrow();
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter @kokoro/credit test`
Expected: FAIL（当前默认 strip，未知字段被静默丢弃，不抛错）。

- [ ] **Step 3: 加 `.strict()` 与 env 注释**

```ts
// kokoro-credit/src/interfaces/http/schemas.ts
import { z } from "zod";

const amountMicrosSchema = z.string().regex(/^[1-9]\d*$/);

export const ensureCreditAccountRequestSchema = z
  .object({
    ownerKind: z.enum(["user", "team"]),
    ownerId: z.string().min(1),
  })
  .strict();

export const creditMutationRequestSchema = z
  .object({
    accountId: z.string().min(1),
    amountMicros: amountMicrosSchema,
    idempotencyKey: z.string().min(1),
    reason: z.enum(["manual_adjustment", "subscription", "model_call", "tool_call", "refund"]),
    requestId: z.string().min(1).optional(),
  })
  .strict();
```

```ts
// kokoro-credit/src/config/env.ts — 在 creditEnvSchema 定义上方加 1 行 WHY 注释
// 故意不 .strict()：parse 整个 process.env 超集，strict 会被 PATH/HOME 等无关变量拒绝。
export const creditEnvSchema = z.object({
```

- [ ] **Step 4: 运行确认通过 + 不回归**

Run: `pnpm --filter @kokoro/credit test`
Expected: PASS（含原有 unit 测试）。

- [ ] **Step 5: 提交**

```bash
git add kokoro-credit/src/interfaces/http/schemas.ts kokoro-credit/src/config/env.ts kokoro-credit/test/unit/credit-schemas.test.ts
git commit -m "harden(credit): HTTP 载荷 schema .strict() 拒绝未知字段"
```

---

### Task 2: schema 边界矩阵单元测试

**Files:**
- Modify: `kokoro-credit/test/unit/credit-schemas.test.ts`

**Interfaces:**
- Consumes: Task 1 的两个严格 schema。
- Produces: 无新导出，仅扩测试。

- [ ] **Step 1: 追加参数化边界测试**

```ts
// 追加到 kokoro-credit/test/unit/credit-schemas.test.ts
describe("creditMutationRequestSchema.amountMicros boundaries", () => {
  const base = { accountId: "a1", idempotencyKey: "k1", reason: "subscription" as const };

  it.each(["0", "-1", "", "abc", "01", " 5", "1.5", "12.0", "5x"])(
    "rejects invalid amountMicros %j",
    (amountMicros) => {
      expect(() => creditMutationRequestSchema.parse({ ...base, amountMicros })).toThrow();
    },
  );

  it.each(["1", "1000000", "99999999999999999999999999"])(
    "accepts positive integer string %j",
    (amountMicros) => {
      expect(creditMutationRequestSchema.parse({ ...base, amountMicros }).amountMicros).toBe(amountMicros);
    },
  );
});

describe("credit schemas enum + required", () => {
  it("rejects invalid ownerKind", () => {
    expect(() => ensureCreditAccountRequestSchema.parse({ ownerKind: "org", ownerId: "u1" })).toThrow();
  });
  it("rejects empty ownerId", () => {
    expect(() => ensureCreditAccountRequestSchema.parse({ ownerKind: "user", ownerId: "" })).toThrow();
  });
  it("rejects invalid reason", () => {
    expect(() =>
      creditMutationRequestSchema.parse({ accountId: "a1", amountMicros: "1", idempotencyKey: "k1", reason: "gift" }),
    ).toThrow();
  });
  it("rejects missing idempotencyKey", () => {
    expect(() =>
      creditMutationRequestSchema.parse({ accountId: "a1", amountMicros: "1", reason: "subscription" }),
    ).toThrow();
  });
  it("accepts omitted optional requestId", () => {
    expect(
      creditMutationRequestSchema.parse({ accountId: "a1", amountMicros: "1", idempotencyKey: "k1", reason: "subscription" })
        .requestId,
    ).toBeUndefined();
  });
  it("rejects empty requestId", () => {
    expect(() =>
      creditMutationRequestSchema.parse({
        accountId: "a1",
        amountMicros: "1",
        idempotencyKey: "k1",
        reason: "subscription",
        requestId: "",
      }),
    ).toThrow();
  });
});
```

- [ ] **Step 2: 运行确认通过**

Run: `pnpm --filter @kokoro/credit test`
Expected: PASS（全部边界用例通过；`/^[1-9]\d*$/` 拒绝 `0/-1/空/abc/01/前导空格/小数`）。

- [ ] **Step 3: 提交**

```bash
git add kokoro-credit/test/unit/credit-schemas.test.ts
git commit -m "test(credit): schema 边界矩阵（amountMicros/enum/required）"
```

---

### Task 3: CreditService 守卫单元测试

**Files:**
- Test: `kokoro-credit/test/unit/credit-service.test.ts` (create)

**Interfaces:**
- Consumes: `CreditService`（`src/application/credit-service.ts`）、`CreditRepository`（`src/domain/repository.ts`）、`CreditMutationResult`/`CreditAccount`（`src/domain/credit.ts`）。
- Produces: 无新导出。

- [ ] **Step 1: 写测试（完整类型桩，不用 cast）**

```ts
// kokoro-credit/test/unit/credit-service.test.ts
import { describe, expect, it } from "vitest";
import { CreditService } from "../../src/application/credit-service.js";
import type { CreditAccount, CreditMutationResult } from "../../src/domain/credit.js";
import type { CreditRepository } from "../../src/domain/repository.js";

const account: CreditAccount = {
  id: "a1",
  ownerKind: "user",
  ownerId: "u1",
  status: "active",
  balanceMicros: "0",
  heldMicros: "0",
  createdAt: new Date(0),
  updatedAt: new Date(0),
};
const result: CreditMutationResult = {
  account,
  entry: {
    id: "e1",
    accountId: "a1",
    amountMicros: "1",
    balanceAfterMicros: "1",
    reason: "subscription",
    idempotencyKey: "k1",
    requestId: null,
    createdAt: new Date(0),
  },
};

function trackingRepo(): { repo: CreditRepository; calls: string[] } {
  const calls: string[] = [];
  const repo: CreditRepository = {
    ensureAccount: async () => {
      calls.push("ensureAccount");
      return account;
    },
    grantCredits: async () => {
      calls.push("grantCredits");
      return result;
    },
    spendCredits: async () => {
      calls.push("spendCredits");
      return result;
    },
  };
  return { repo, calls };
}

describe("CreditService positive-amount guard", () => {
  it.each(["0", "-1", ""])("grantCredits rejects %j before repository", async (amountMicros) => {
    const { repo, calls } = trackingRepo();
    const service = new CreditService(repo);
    await expect(
      service.grantCredits({ accountId: "a1", amountMicros, idempotencyKey: "k1", reason: "subscription" }),
    ).rejects.toThrow("amountMicros must be positive");
    expect(calls).not.toContain("grantCredits");
  });

  it.each(["0", "-1", ""])("spendCredits rejects %j before repository", async (amountMicros) => {
    const { repo, calls } = trackingRepo();
    const service = new CreditService(repo);
    await expect(
      service.spendCredits({ accountId: "a1", amountMicros, idempotencyKey: "k1", reason: "model_call" }),
    ).rejects.toThrow("amountMicros must be positive");
    expect(calls).not.toContain("spendCredits");
  });

  it("passes valid amount through to repository", async () => {
    const { repo, calls } = trackingRepo();
    const service = new CreditService(repo);
    await service.grantCredits({ accountId: "a1", amountMicros: "100", idempotencyKey: "k1", reason: "subscription" });
    expect(calls).toContain("grantCredits");
  });
});
```

- [ ] **Step 2: 运行确认通过**

Run: `pnpm --filter @kokoro/credit test`
Expected: PASS。（注：`""` 经 `BigInt("")` = 0n → `parsePositiveBigIntString` 抛 "amountMicros must be positive"。）

- [ ] **Step 3: 提交**

```bash
git add kokoro-credit/test/unit/credit-service.test.ts
git commit -m "test(credit): CreditService 正数守卫单元测试（类型桩）"
```

---

### Task 4: 消除 infrastructure 层类型断言

**Files:**
- Modify: `kokoro-credit/src/infrastructure/prisma/prisma-credit-repository.ts:182-192`

**Interfaces:**
- Consumes: 内部 `defined()` helper（仅本文件使用）。
- Produces: `defined()` 行为不变，返回类型改为 `Partial<Record<Key, Value>>`，无 cast。

- [ ] **Step 1: 重写 `defined()` 去掉 cast**

```ts
// 替换现有 defined()
function defined<Key extends string, Value>(
  key: Key,
  value: Value | undefined,
): Partial<Record<Key, Value>> {
  if (value === undefined) {
    return {};
  }
  const out: Partial<Record<Key, Value>> = {};
  out[key] = value;
  return out;
}
```

- [ ] **Step 2: 确认全文件零 cast**

Run: `grep -nE '\bas [A-Za-z]' kokoro-credit/src/infrastructure/prisma/prisma-credit-repository.ts | grep -v 'as const'`
Expected: 无输出。

- [ ] **Step 3: typecheck + 既有测试不回归**

Run: `pnpm --filter @kokoro/credit typecheck && pnpm --filter @kokoro/credit test`
Expected: PASS（`...defined("requestId", input.requestId)` 展开类型仍兼容 Prisma create data）。

- [ ] **Step 4: 提交**

```bash
git add kokoro-credit/src/infrastructure/prisma/prisma-credit-repository.ts
git commit -m "harden(credit): defined() 去除类型断言（Partial<Record> 构造）"
```

---

### Task 5: 集成测试 — 幂等与余额不足（真 MySQL）

**Files:**
- Test: `kokoro-credit/test/integration/credit-idempotency.test.ts` (create)

**Interfaces:**
- Consumes: `createCreditServer`（`src/interfaces/http/server.js`）、`cleanCreditDatabase`/`createTestPrismaClient`（`test/integration/helpers.js`）。
- Produces: 无新导出。

- [ ] **Step 1: 启动本地 DB 并迁移**

```bash
pnpm --filter @kokoro/credit exec true   # 占位：确保 workspace 就绪
cd kokoro-platform && pnpm dev:db && pnpm db:migrate && pnpm db:generate && cd ..
export DATABASE_URL_CREDIT="mysql://root:kokoro_root@127.0.0.1:3307/kokoro"
```

若本机无法起 docker MySQL：在最终报告显式标注「集成测试未验（无 DB）」，不得 `skip` 掩盖，继续交付 unit + typecheck + lint 证据。

- [ ] **Step 2: 写集成测试**

```ts
// kokoro-credit/test/integration/credit-idempotency.test.ts
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createCreditServer } from "../../src/interfaces/http/server.js";
import { cleanCreditDatabase, createTestPrismaClient } from "./helpers.js";

const prisma = createTestPrismaClient();
const app = createCreditServer({ prisma });

async function ensureAccount(ownerId: string): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/credit/accounts/ensure",
    payload: { ownerKind: "team", ownerId },
  });
  return res.json().data.id as string;
}

describe("credit idempotency & overdraft", () => {
  beforeEach(async () => {
    await cleanCreditDatabase(prisma);
  });
  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  it("does not double-credit on repeated grant with same idempotencyKey", async () => {
    const accountId = await ensureAccount("team_idem_grant");
    const payload = { accountId, amountMicros: "5000000", idempotencyKey: "grant_dup", reason: "subscription" };

    const first = await app.inject({ method: "POST", url: "/credit/grant", payload });
    const second = await app.inject({ method: "POST", url: "/credit/grant", payload });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(first.json().data.account.balanceMicros).toBe("5000000");
    expect(second.json().data.account.balanceMicros).toBe("5000000");
  });

  it("does not double-spend on repeated spend with same idempotencyKey", async () => {
    const accountId = await ensureAccount("team_idem_spend");
    await app.inject({
      method: "POST",
      url: "/credit/grant",
      payload: { accountId, amountMicros: "5000000", idempotencyKey: "seed_grant", reason: "subscription" },
    });
    const spend = { accountId, amountMicros: "2000000", idempotencyKey: "spend_dup", reason: "model_call" };

    const first = await app.inject({ method: "POST", url: "/credit/spend", payload: spend });
    const second = await app.inject({ method: "POST", url: "/credit/spend", payload: spend });

    expect(first.json().data.account.balanceMicros).toBe("3000000");
    expect(second.json().data.account.balanceMicros).toBe("3000000");
  });

  it("rejects unknown fields at HTTP boundary with 400", async () => {
    const accountId = await ensureAccount("team_strict");
    const res = await app.inject({
      method: "POST",
      url: "/credit/grant",
      payload: { accountId, amountMicros: "1", idempotencyKey: "k", reason: "subscription", bogus: 1 },
    });
    expect(res.statusCode).toBe(400);
  });
});
```

- [ ] **Step 3: 运行集成测试**

Run: `pnpm --filter @kokoro/credit test:integration`
Expected: PASS（幂等不重复记账；strict 越界字段 → 400）。

- [ ] **Step 4: 提交**

```bash
git add kokoro-credit/test/integration/credit-idempotency.test.ts
git commit -m "test(credit): 集成幂等/越界字段 400 用例"
```

---

### Task 6: 覆盖率工具与门槛 + 全量验证

**Files:**
- Create: `kokoro-credit/vitest.config.ts`
- Modify: `kokoro-credit/package.json`（devDep + script）

**Interfaces:**
- Consumes: 前序所有测试。
- Produces: `pnpm --filter @kokoro/credit coverage` 脚本，覆盖率阈值 95%。

- [ ] **Step 1: 安装覆盖率工具**

Run: `cd kokoro-platform && pnpm --filter @kokoro/credit add -D @vitest/coverage-v8 && cd ..`
Expected: devDependency 写入 `kokoro-credit/package.json`，lockfile 更新。

- [ ] **Step 2: 写 vitest 覆盖配置**

```ts
// kokoro-credit/vitest.config.ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.d.ts", "src/index.ts", "src/interfaces/http/main.ts"],
      thresholds: { lines: 95, branches: 95, functions: 95, statements: 95 },
    },
  },
});
```

- [ ] **Step 3: 加 coverage 脚本**

```jsonc
// kokoro-credit/package.json -> scripts 增加：
"coverage": "vitest run --coverage --no-file-parallelism"
```

- [ ] **Step 4: 运行覆盖率（需 DB；unit+integration 合并）**

Run: `export DATABASE_URL_CREDIT="mysql://root:kokoro_root@127.0.0.1:3307/kokoro" && pnpm --filter @kokoro/credit coverage`
Expected: PASS 且 lines/branches/functions/statements ≥ 95%。若某文件拖低，回到对应 Task 补针对性用例（不为凑数写空测试）。
若无 DB：改跑 `pnpm --filter @kokoro/credit test -- --coverage` 仅 unit，记录 unit 覆盖率并标注 integration 未计入。

- [ ] **Step 5: 全量门禁**

Run:
```bash
pnpm --filter @kokoro/credit typecheck; echo "tc=$?"
pnpm --filter @kokoro/credit lint; echo "lint=$?"
pnpm --filter @kokoro/credit test; echo "unit=$?"
pnpm --filter @kokoro/credit test:integration; echo "it=$?"
```
Expected: 全部 exit=0（无 DB 时 it 段如实标注未验）。

- [ ] **Step 6: 提交**

```bash
git add kokoro-credit/vitest.config.ts kokoro-credit/package.json ../pnpm-lock.yaml
git commit -m "test(credit): 引入 v8 覆盖率工具与 95% 阈值"
```

---

## 收尾（计划执行完毕后）

- 在 worktree 子模块 `polish/credit-quality` 上的所有提交，由用户决定是否合并到 kokoro-platform main、并 bump 主仓 gitlink（参照 ADR-007，指针 bump 是显式动作）。
- 标杆定稿后，site/user/model/payment 复用同一 6 步模式（另起计划）。
