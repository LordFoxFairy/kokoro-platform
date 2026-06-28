import { defineConfig } from "vitest/config";

// 覆盖率只计业务逻辑；排除 barrel 与 HTTP 服务启动胶水（无逻辑、不可单测）。
export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/index.ts", "src/http/start-server.ts"],
      thresholds: { lines: 95, functions: 95, statements: 95, branches: 90 },
    },
  },
});
