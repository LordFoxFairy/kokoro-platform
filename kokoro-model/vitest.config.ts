import { defineConfig } from "vitest/config";

// 覆盖率只计业务逻辑；排除 bootstrap 胶水（barrel/入口/服务装配/DB client，无逻辑、不可单测）。
export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: [
        "src/index.ts",
        "src/interfaces/http/main.ts",
        "src/interfaces/http/server.ts",
        "src/infrastructure/prisma/prisma-client.ts",
      ],
      thresholds: { lines: 95, functions: 95, statements: 95, branches: 80 },
    },
  },
});
