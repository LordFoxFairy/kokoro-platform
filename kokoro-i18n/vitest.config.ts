import { defineConfig } from "vitest/config";

// 覆盖率只计引擎逻辑；barrel（无逻辑）排除。窄包全量可测，阈值对齐仓内其它包。
export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      thresholds: { lines: 95, functions: 95, statements: 95, branches: 90 },
    },
  },
});
