import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default [
  {
    ignores: [
      "dist/**",
      "**/dist/**",
      "coverage/**",
      "node_modules/**",
      "**/node_modules/**",
      "**/.next/**",
      "**/out/**",
      "**/build/**",
      "**/generated/**",
      "src/interfaces/connect/generated-product-catalog-publication/**",
      "**/next-env.d.ts",
      "**/*.tsbuildinfo",
      "kokoro-platform-admin/**",
      "kokoro-site/**",
      "kokoro-user/**",
      "kokoro-model/**",
      "kokoro-credit/**",
      "kokoro-payment/**",
      "scripts/integration-dev.mjs",
      "scripts/model-control/export-legacy.mts",
      "scripts/model-control/materialize-legacy-options.mts",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["scripts/**/*.mjs"],
    languageOptions: {
      globals: {
        console: "readonly",
        process: "readonly",
      },
    },
  },
  {
    files: ["**/*.ts"],
    rules: {
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
        },
      ],
    },
  },
  {
    files: ["src/modules/*/domain/**/*.ts", "src/modules/*/application/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@prisma/**", "**/generated/platform-prisma/**", "**/infrastructure/**"],
              message: "Domain/application code depends on public owner ports, never ORM or infrastructure implementations.",
            },
            {
              group: ["**/shared/unit-of-work/platform-transaction*"],
              message: "Application code imports the opaque transaction from the public unit-of-work barrel.",
            },
            {
              group: ["**/security-context/request-security-context*", "**/policy/domain/verified-risk-decision*"],
              message: "Application code consumes verified capabilities; cryptographic issuance is an interface/infrastructure responsibility.",
            },
          ],
        },
      ],
    },
  },
];
