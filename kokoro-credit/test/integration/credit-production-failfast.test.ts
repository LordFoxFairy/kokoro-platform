import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// 生产缺凭据 fail-fast（TRUST-ROUTES 验收）：真实 spawn credit main，断言进程非零退出。
// KOKORO_ENV=production 且缺 KOKORO_INTERNAL_SECRET_SESSION（credit 所需 caller 之一）→ 启动即抛。
const creditRoot = fileURLToPath(new URL("../..", import.meta.url));

function runMain(env: Record<string, string>): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("npx", ["tsx", "src/interfaces/http/main.ts"], {
      cwd: creditRoot,
      env: { ...process.env, ...env },
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.stdout.on("data", () => {});
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ code: null, stderr: stderr + "\n[timeout: 进程未在预期内退出]" });
    }, 30_000);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, stderr });
    });
  });
}

describe("credit 生产 fail-fast", () => {
  it(
    "生产环境缺 caller 凭据 → 启动非零退出",
    async () => {
      const { code, stderr } = await runMain({
        KOKORO_ENV: "production",
        DATABASE_URL_CREDIT: "mysql://root:pw@127.0.0.1:59999/kokoro_missing",
        // 只配 admin，缺 session/payment/credit → registerRouteAccess 抛 MissingCallerCredentialError
        KOKORO_INTERNAL_SECRET_ADMIN: "example-admin",
      });
      expect(code).not.toBe(0);
      expect(stderr).toMatch(/内部调用方凭据|MissingCallerCredential/);
    },
    35_000,
  );
});
