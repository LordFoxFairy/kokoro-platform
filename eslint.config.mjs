import js from "@eslint/js";
import tseslint from "typescript-eslint";

const paymentReadRuntimeFiles = [
  "kokoro-payment/src/config/env.ts",
  "kokoro-payment/src/domain/payment-lifecycle.ts",
  "kokoro-payment/src/domain/payment.ts",
  "kokoro-payment/src/domain/provider.ts",
  "kokoro-payment/src/domain/read-repository.ts",
  "kokoro-payment/src/infrastructure/prisma/prisma-client.ts",
  "kokoro-payment/src/infrastructure/prisma/prisma-payment-read-repository.ts",
  "kokoro-payment/src/interfaces/admin/**/*.ts",
  "kokoro-payment/src/interfaces/http/**/*.ts",
];

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
      "**/next-env.d.ts",
      "**/*.tsbuildinfo",
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
  {
    files: paymentReadRuntimeFiles,
    languageOptions: {
      globals: {
        setInterval: "readonly",
        setTimeout: "readonly",
      },
    },
    rules: {
      "no-eval": "error",
      "no-implied-eval": "error",
      "no-new-func": "error",
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@kokoro/credit",
              message: "The Payment read runtime must not acquire Credit mutation capabilities.",
            },
            {
              name: "@kokoro/platform-kit",
              importNames: ["callService"],
              message: "The Payment read runtime must not acquire the generic service caller.",
            },
          ],
          patterns: [
            {
              group: ["**/application/**", "**/infrastructure/credit-grant-client*", "**/infrastructure/webhook/**"],
              caseSensitive: true,
              message: "The Payment read runtime has a closed import graph and cannot import acquisition services.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["kokoro-payment/src/interfaces/http/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@kokoro/credit",
              message: "Payment HTTP routes must not acquire Credit mutation capabilities.",
            },
            {
              name: "@kokoro/platform-kit",
              importNames: ["callService"],
              message: "Payment HTTP routes must use their exact injected read capabilities.",
            },
            {
              name: "../../domain/repository.js",
              message: "Payment HTTP routes must use the exact read repository ports.",
            },
            {
              name: "../../infrastructure/prisma/prisma-client.js",
              message: "Raw Prisma clients are forbidden in Payment HTTP composition.",
            },
            {
              name: "../../infrastructure/prisma/prisma-payment-repository.js",
              message: "The full Payment repository is forbidden in Payment HTTP composition.",
            },
          ],
          patterns: [
            {
              group: ["**/application/**", "**/infrastructure/credit-grant-client*", "**/infrastructure/webhook/**"],
              caseSensitive: true,
              message: "Payment HTTP composition cannot import acquisition services.",
            },
          ],
        },
      ],
    },
  },
];
