#!/usr/bin/env node
// 一键跑全平台集成套件(打本机真 MySQL)。
//
// 为何需要它:各包的 test:integration 需要 DATABASE_URL_<SVC>,而这些值散在 deploy/.env.dev,
// 没人手动拼 → 整个集成层长期没被跑过。曾因此漏掉 27 条真红(整数扣费回归 + 契约漂移),
// 而单测全绿看不出来。此脚本从 deploy/.env.dev 派生 URL(与 scripts/closure-up.py 同源口径)后转发。
//
//   node scripts/integration-dev.mjs            # 全部包
//   node scripts/integration-dev.mjs credit hub # 只跑指定包

import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))
const ENV_DEV = resolve(HERE, "../../deploy/.env.dev")

function readEnvDev(name, fallback) {
  try {
    const text = readFileSync(ENV_DEV, "utf8")
    return text.match(new RegExp(`^${name}=(.*)$`, "m"))?.[1]?.trim() || fallback
  } catch {
    return fallback
  }
}

const password = readEnvDev("MYSQL_ROOT_PASSWORD", "kokoro_root")
const port = readEnvDev("KOKORO_MYSQL_PORT", "3307")
const url = `mysql://root:${password}@127.0.0.1:${port}/kokoro`

// 各包只读自己那个键；一次性全注入省去按包分支。
const env = { ...process.env }
for (const svc of ["SITE", "USER", "MODEL", "CREDIT", "PAYMENT", "HUB"]) {
  env[`DATABASE_URL_${svc}`] = url
}

// platform-admin 的回执用例会清空 operator/auth 全部表,故只肯打独立库 kokoro_admin_verify
// (见 kokoro-platform-admin/test/integration/admin-auth-prisma.test.ts 的 fail-loud 守卫)。
// 不注入这条,那 5 条会明确报错而不是静默不跑;该库需先 db:migrate 建好。
env.DATABASE_URL_ADMIN = `mysql://root:${password}@127.0.0.1:${port}/kokoro_admin_verify`

const packages = process.argv.slice(2)
const args =
  packages.length > 0
    ? packages.flatMap((name) => ["--filter", `@kokoro/${name}`]).concat(["test:integration"])
    : ["-r", "test:integration"]

console.log(`集成套件 → MySQL 127.0.0.1:${port}（凭据取自 deploy/.env.dev）`)
const result = spawnSync("pnpm", args, { cwd: resolve(HERE, ".."), env, stdio: "inherit" })
process.exit(result.status ?? 1)
