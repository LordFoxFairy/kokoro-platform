import { defineConfig } from "vitest/config";
import { fileURLToPath } from "url";
import { dirname } from "path";

// adapter/纯逻辑单测：node 环境 + 手动 @ 别名（避免 ESM-only 插件在 CJS 配置里 require 失败）。
const root = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: { alias: { "@": root } },
  test: {
    environment: "node",
    include: ["lib/**/*.test.ts"],
  },
});
