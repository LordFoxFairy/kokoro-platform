import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath, URL } from "node:url";
import test from "node:test";
import ts from "typescript";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const PAYMENT_SOURCE_ROOT = "kokoro-payment/src";

const HTTP_SOURCE_ALLOWLIST = [
  "kokoro-payment/src/interfaces/http/admin-routes.ts",
  "kokoro-payment/src/interfaces/http/main.ts",
  "kokoro-payment/src/interfaces/http/read-repository.ts",
  "kokoro-payment/src/interfaces/http/routes.ts",
  "kokoro-payment/src/interfaces/http/schemas.ts",
  "kokoro-payment/src/interfaces/http/server.ts",
  "kokoro-payment/src/interfaces/http/webhook-routes.ts",
];

const RUNTIME_ROOTS = [
  "kokoro-payment/src/index.ts",
  "kokoro-payment/src/interfaces/http/main.ts",
  "kokoro-payment/src/interfaces/http/read-repository.ts",
  "kokoro-payment/src/interfaces/http/server.ts",
  "kokoro-payment/src/module.ts",
  "kokoro-payment/src/interfaces/http/routes.ts",
  "kokoro-payment/src/interfaces/http/admin-routes.ts",
  "kokoro-payment/src/interfaces/http/webhook-routes.ts",
];

const RUNTIME_GRAPH_ALLOWLIST = [
  "kokoro-payment/src/config/env.ts",
  "kokoro-payment/src/domain/amount.ts",
  "kokoro-payment/src/domain/errors.ts",
  "kokoro-payment/src/domain/idempotency.ts",
  "kokoro-payment/src/domain/payment-lifecycle.ts",
  "kokoro-payment/src/domain/payment.ts",
  "kokoro-payment/src/domain/provider.ts",
  "kokoro-payment/src/domain/repository.ts",
  "kokoro-payment/src/domain/webhook.ts",
  "kokoro-payment/src/index.ts",
  "kokoro-payment/src/infrastructure/prisma/prisma-client.ts",
  "kokoro-payment/src/infrastructure/prisma/prisma-payment-repository.ts",
  "kokoro-payment/src/interfaces/admin/manifest.ts",
  "kokoro-payment/src/interfaces/admin/payment-admin-contract.ts",
  "kokoro-payment/src/interfaces/admin/schema.ts",
  "kokoro-payment/src/interfaces/http/admin-routes.ts",
  "kokoro-payment/src/interfaces/http/main.ts",
  "kokoro-payment/src/interfaces/http/read-repository.ts",
  "kokoro-payment/src/interfaces/http/routes.ts",
  "kokoro-payment/src/interfaces/http/schemas.ts",
  "kokoro-payment/src/interfaces/http/server.ts",
  "kokoro-payment/src/interfaces/http/webhook-routes.ts",
  "kokoro-payment/src/module.ts",
];

const EXTERNAL_IMPORT_ALLOWLIST = ["@kokoro/platform-kit", "fastify", "node:http", "zod"];
const TERMINAL_IMPORT_ALLOWLIST = ["kokoro-payment/generated/prisma/index.js"];

const ACTIVE_POLICY_FILES = [
  "kokoro-payment/src/index.ts",
  "kokoro-payment/src/interfaces/admin/payment-admin-contract.ts",
  "kokoro-payment/src/interfaces/http/admin-routes.ts",
  "kokoro-payment/src/interfaces/http/main.ts",
  "kokoro-payment/src/interfaces/http/read-repository.ts",
  "kokoro-payment/src/interfaces/http/routes.ts",
  "kokoro-payment/src/interfaces/http/server.ts",
  "kokoro-payment/src/interfaces/http/webhook-routes.ts",
  "kokoro-payment/src/module.ts",
];

const ACTIVE_IMPORT_ALLOWLIST = new Map([
  ["kokoro-payment/src/index.ts", ["./config/env.js", "./domain/payment-lifecycle.js", "./domain/payment.js", "./domain/provider.js", "./domain/repository.js", "./domain/webhook.js", "./interfaces/admin/manifest.js", "./interfaces/admin/schema.js", "./interfaces/http/schemas.js", "./interfaces/http/server.js", "./module.js"]],
  ["kokoro-payment/src/interfaces/admin/payment-admin-contract.ts", ["./schema.js"]],
  ["kokoro-payment/src/interfaces/http/admin-routes.ts", ["../admin/manifest.js", "./read-repository.js", "@kokoro/platform-kit", "fastify", "zod"]],
  ["kokoro-payment/src/interfaces/http/main.ts", ["../../config/env.js", "./server.js", "@kokoro/platform-kit"]],
  ["kokoro-payment/src/interfaces/http/read-repository.ts", ["../../domain/repository.js"]],
  ["kokoro-payment/src/interfaces/http/routes.ts", ["./read-repository.js", "@kokoro/platform-kit", "fastify"]],
  ["kokoro-payment/src/interfaces/http/server.ts", ["../../../generated/prisma/index.js", "../../infrastructure/prisma/prisma-client.js", "../../infrastructure/prisma/prisma-payment-repository.js", "./admin-routes.js", "./read-repository.js", "./routes.js", "./webhook-routes.js", "@kokoro/platform-kit", "fastify"]],
  ["kokoro-payment/src/interfaces/http/webhook-routes.ts", ["./routes.js", "@kokoro/platform-kit", "fastify"]],
  ["kokoro-payment/src/module.ts", []],
]);

const MUTATING_REPOSITORY_MEMBERS = new Set([
  "createOrder",
  "deletePlan",
  "deleteProvider",
  "markOrderConfirming",
  "markOrderPaid",
  "recordPaymentEvent",
  "refundOrderAtomically",
  "restorePlan",
  "transitionPaymentEventStatus",
  "upsertPlan",
  "upsertProvider",
  "upsertSubscription",
]);

const PAYMENT_READ_METHODS = [
  "listOrders",
  "listPaymentEvents",
  "listPlans",
  "listProviders",
  "listRefunds",
  "listSubscriptions",
  "readAdminStats",
];

const FORBIDDEN_RUNTIME_IDENTIFIERS = new Set([
  "PaymentService",
  "PaymentWebhookService",
  "callService",
  "createCreditGrantClient",
  "createCreditReverseClient",
  "createWebhookProviderRegistry",
  "enabledProviderKinds",
  "fetch",
  "globalThis",
  "grantPurchaseCredits",
  "providerSdkFactory",
  "Reflect",
  "reverseCredits",
  "setInterval",
  "webhookSecretResolver",
]);
const RUNTIME_ENV_READ_ALLOWLIST = new Set([
  "kokoro-payment/src/config/env.ts",
  "kokoro-payment/src/infrastructure/prisma/prisma-client.ts",
]);

const ALLOWED_LITERAL_ROUTES = new Set([
  "GET /admin/payments/stats",
  "GET /plans",
  "POST /payments/webhooks/:provider",
]);
const HTTP_REGISTRATION_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD", "ALL"]);
const ALLOWED_DYNAMIC_ROUTE_REGISTRATIONS = new Set([
  "kokoro-payment/src/interfaces/http/admin-routes.ts:GET:resource.route",
  "kokoro-payment/src/interfaces/http/routes.ts:POST:route",
]);

const FORBIDDEN_SEED_MEMBER = /\.(?:createOrder|recordPaymentEvent|upsertProvider|upsertSubscription|refundOrderAtomically)\s*\(/u;

function normalized(path) {
  return path.split(sep).join("/");
}

async function listTypeScriptFiles(directory) {
  const files = [];
  for (const entry of await readdir(resolve(ROOT, directory), { withFileTypes: true })) {
    const child = `${directory}/${entry.name}`;
    if (entry.isDirectory()) files.push(...await listTypeScriptFiles(child));
    else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(child);
  }
  return files.sort();
}

function sourceFile(file, source) {
  return ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function importsFrom(file, source) {
  const imports = [];
  const dynamicImports = [];
  const ast = sourceFile(file, source);
  const visit = (node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      imports.push(node.moduleSpecifier.text);
    }
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) {
      dynamicImports.push(node.getText(ast));
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return { imports, dynamicImports };
}

function resolveLocalImport(fromFile, specifier) {
  const raw = normalized(relative(ROOT, resolve(ROOT, dirname(fromFile), specifier)));
  const sourceCandidate = raw.replace(/\.js$/u, ".ts");
  if (sourceCandidate.startsWith(`${PAYMENT_SOURCE_ROOT}/`) && existsSync(resolve(ROOT, sourceCandidate))) {
    return { kind: "source", path: sourceCandidate };
  }
  return { kind: "terminal", path: raw };
}

async function buildRuntimeGraph(overrides = new Map()) {
  const queue = [...RUNTIME_ROOTS];
  const files = new Set();
  const externalImports = new Set();
  const terminalImports = new Set();
  const dynamicImports = [];
  while (queue.length > 0) {
    const file = queue.shift();
    if (files.has(file)) continue;
    files.add(file);
    const source = overrides.get(file) ?? await readFile(resolve(ROOT, file), "utf8");
    const parsed = importsFrom(file, source);
    dynamicImports.push(...parsed.dynamicImports.map((entry) => `${file}: ${entry}`));
    for (const specifier of parsed.imports) {
      if (!specifier.startsWith(".")) {
        externalImports.add(specifier);
        continue;
      }
      const target = resolveLocalImport(file, specifier);
      if (target.kind === "source") queue.push(target.path);
      else terminalImports.add(target.path);
    }
  }
  return {
    files: [...files].sort(),
    externalImports: [...externalImports].sort(),
    terminalImports: [...terminalImports].sort(),
    dynamicImports: dynamicImports.sort(),
  };
}

function runtimeContentViolations(file, source) {
  const violations = [];
  const ast = sourceFile(file, source);
  const visit = (node) => {
    if (ts.isIdentifier(node) && FORBIDDEN_RUNTIME_IDENTIFIERS.has(node.text)) {
      violations.push(`${file}: forbidden runtime identifier ${node.text}`);
    }
    if (!RUNTIME_ENV_READ_ALLOWLIST.has(file) && isProcessEnvAccess(node)) {
      violations.push(`${file}: direct environment read ${node.getText(ast)}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return [...new Set(violations)].sort();
}

function isProcessEnvAccess(node) {
  return (
    ts.isPropertyAccessExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "process" &&
    node.name.text === "env"
  );
}

function bindingPropertyName(node) {
  const property = node.propertyName ?? node.name;
  if (ts.isIdentifier(property) || ts.isStringLiteral(property) || ts.isNumericLiteral(property)) {
    return property.text;
  }
  if (ts.isComputedPropertyName(property) && ts.isStringLiteral(property.expression)) {
    return property.expression.text;
  }
  return undefined;
}

function productionSourceViolations(file, source) {
  const violations = runtimeContentViolations(file, source);
  const ast = sourceFile(file, source);
  const visit = (node) => {
    if (ts.isBindingElement(node)) {
      const member = bindingPropertyName(node);
      if (member && MUTATING_REPOSITORY_MEMBERS.has(member)) {
        violations.push(`${file}: mutating member ${member}`);
      }
    }
    if (ts.isPropertyAccessExpression(node) && MUTATING_REPOSITORY_MEMBERS.has(node.name.text)) {
      violations.push(`${file}: mutating member ${node.name.text}`);
    }
    if (ts.isElementAccessExpression(node) && ts.isStringLiteral(node.argumentExpression) && MUTATING_REPOSITORY_MEMBERS.has(node.argumentExpression.text)) {
      violations.push(`${file}: mutating member ${node.argumentExpression.text}`);
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text.toUpperCase();
      const path = node.arguments[0];
      if (method === "ROUTE") {
        violations.push(`${file}: generic route registration is not allowed`);
      } else if (HTTP_REGISTRATION_METHODS.has(method)) {
        if (path && ts.isStringLiteral(path)) {
          const route = `${method} ${path.text}`;
          if (!ALLOWED_LITERAL_ROUTES.has(route)) violations.push(`${file}: unapproved literal route ${route}`);
        } else {
          const registration = `${file}:${method}:${path?.getText(ast) ?? "<missing>"}`;
          if (!ALLOWED_DYNAMIC_ROUTE_REGISTRATIONS.has(registration)) {
            violations.push(`${file}: unapproved dynamic route ${registration}`);
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return [...new Set(violations)].sort();
}

function deploymentTemplateViolations(source) {
  for (const line of source.split(/\r?\n/u)) {
    const match = /^\s*([A-Z][A-Z0-9_]*)\s*=/u.exec(line);
    if (!match) continue;
    const key = match[1];
    if (
      (key.includes("WEBHOOK") && key.includes("SECRET")) ||
      /^KOKORO_(?:USER|MODEL|CREDIT|PAYMENT)_BASE_URL$/u.test(key) ||
      /^KOKORO_PAYMENT_(?:ENABLED_PROVIDERS|CONFIRM_.+|ALIPAY_PUBLIC_KEY|WECHAT_PLATFORM_CERT)$/u.test(key)
    ) {
      return ["deprecated acquisition setting in .env.example"];
    }
  }
  return [];
}

function functionParameterType(source, functionName, parameterIndex) {
  const ast = sourceFile("fixture.ts", source);
  let result;
  const visit = (node) => {
    if (
      ts.isFunctionDeclaration(node) &&
      node.name?.text === functionName &&
      node.parameters[parameterIndex]?.type
    ) {
      result = node.parameters[parameterIndex].type.getText(ast);
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return result;
}

function paymentReadBoundaryViolations(sources) {
  const violations = [];
  const routes = sources.get("routes") ?? "";
  const adminRoutes = sources.get("adminRoutes") ?? "";
  const adapter = sources.get("adapter") ?? "";
  const server = sources.get("server") ?? "";

  for (const [name, source, functionName, expectedType] of [
    ["routes", routes, "registerPaymentRoutes", "PaymentCatalogRepository"],
    ["admin-routes", adminRoutes, "registerPaymentAdminRoutes", "PaymentAdminRepository"],
  ]) {
    const parsed = importsFrom(`${name}.ts`, source);
    if (parsed.imports.includes("../../domain/repository.js")) {
      violations.push(`${name}: full PaymentRepository import is forbidden`);
    }
    if (!parsed.imports.includes("./read-repository.js")) {
      violations.push(`${name}: named read repository port import is required`);
    }
    if (functionParameterType(source, functionName, 1) !== expectedType) {
      violations.push(`${name}: repository parameter must be ${expectedType}`);
    }
  }

  const adapterAst = sourceFile("read-repository.ts", adapter);
  let declaredMethods = [];
  let exposedMethods = [];
  const visitAdapter = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "PAYMENT_READ_METHODS") {
      let initializer = node.initializer;
      if (initializer && ts.isAsExpression(initializer)) initializer = initializer.expression;
      if (initializer && ts.isArrayLiteralExpression(initializer)) {
        declaredMethods = initializer.elements.filter(ts.isStringLiteral).map((entry) => entry.text).sort();
      }
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "Object" &&
      node.expression.name.text === "freeze" &&
      node.arguments[0] &&
      ts.isObjectLiteralExpression(node.arguments[0])
    ) {
      exposedMethods = node.arguments[0].properties
        .map((property) => property.name)
        .filter(Boolean)
        .map((name) => name.text)
        .sort();
    }
    ts.forEachChild(node, visitAdapter);
  };
  visitAdapter(adapterAst);
  if (JSON.stringify(declaredMethods) !== JSON.stringify(PAYMENT_READ_METHODS)) {
    violations.push("adapter: PAYMENT_READ_METHODS must be exact");
  }
  if (JSON.stringify(exposedMethods) !== JSON.stringify(PAYMENT_READ_METHODS)) {
    violations.push("adapter: runtime facade must expose exactly the read methods");
  }
  if (!server.includes("const repository = createPaymentReadRepository(new PrismaPaymentRepository(prisma));")) {
    violations.push("server: full repository must be narrowed at construction");
  }
  return violations.sort();
}

function seedViolations(source) {
  return FORBIDDEN_SEED_MEMBER.test(source) ? ["catalog seed contains acquisition mutation"] : [];
}

test("production HTTP source inventory is closed", async () => {
  assert.deepEqual(
    await listTypeScriptFiles("kokoro-payment/src/interfaces/http"),
    HTTP_SOURCE_ALLOWLIST,
  );
});

test("runtime import graph is closed and has no SDK or dynamic-import escape hatch", async () => {
  assert.deepEqual(await buildRuntimeGraph(), {
    files: RUNTIME_GRAPH_ALLOWLIST,
    externalImports: EXTERNAL_IMPORT_ALLOWLIST,
    terminalImports: TERMINAL_IMPORT_ALLOWLIST,
    dynamicImports: [],
  });
});

test("production composition sources contain no acquisition mutation or assembly", async () => {
  const violations = [];
  for (const file of ACTIVE_POLICY_FILES) {
    violations.push(...productionSourceViolations(file, await readFile(resolve(ROOT, file), "utf8")));
  }
  assert.deepEqual(violations, []);
});

test("every runtime-reachable source is free of provider egress, SDK assembly, and secret reads", async () => {
  const violations = [];
  for (const file of RUNTIME_GRAPH_ALLOWLIST) {
    violations.push(...runtimeContentViolations(file, await readFile(resolve(ROOT, file), "utf8")));
  }
  assert.deepEqual(violations, []);
});

test("every active composition file has an exact direct-import allowlist", async () => {
  for (const [file, allowed] of ACTIVE_IMPORT_ALLOWLIST) {
    const parsed = importsFrom(file, await readFile(resolve(ROOT, file), "utf8"));
    assert.deepEqual([...new Set(parsed.imports)].sort(), allowed, file);
  }
});

test("Payment HTTP composition exposes only exact read repository ports", async () => {
  assert.deepEqual(
    paymentReadBoundaryViolations(new Map([
      ["routes", await readFile(resolve(ROOT, "kokoro-payment/src/interfaces/http/routes.ts"), "utf8")],
      ["adminRoutes", await readFile(resolve(ROOT, "kokoro-payment/src/interfaces/http/admin-routes.ts"), "utf8")],
      ["adapter", await readFile(resolve(ROOT, "kokoro-payment/src/interfaces/http/read-repository.ts"), "utf8")],
      ["server", await readFile(resolve(ROOT, "kokoro-payment/src/interfaces/http/server.ts"), "utf8")],
    ])),
    [],
  );
});

test("deployment template and catalogue seed remain acquisition-free", async () => {
  assert.deepEqual(
    deploymentTemplateViolations(await readFile(resolve(ROOT, "kokoro-payment/.env.example"), "utf8")),
    [],
  );
  assert.deepEqual(
    seedViolations(await readFile(resolve(ROOT, "kokoro-payment/src/interfaces/cli/seed-packs.ts"), "utf8")),
    [],
  );
});

test("HTTP inventory detector bears weight against a new production route file", async () => {
  assert.notDeepEqual(
    [...HTTP_SOURCE_ALLOWLIST, "kokoro-payment/src/interfaces/http/acquisition-routes.ts"].sort(),
    HTTP_SOURCE_ALLOWLIST,
  );
});

test("runtime graph detectors bear weight against local service, SDK, and dynamic imports", async () => {
  const server = await readFile(resolve(ROOT, "kokoro-payment/src/interfaces/http/server.ts"), "utf8");
  const fixtures = [
    `${server}\nimport { PaymentService } from "../../application/payment-service.js";`,
    `${server}\nimport Stripe from "stripe";`,
    `${server}\nconst moduleName = "../../application/payment-service.js"; void import(moduleName);`,
  ];
  for (const fixture of fixtures) {
    const graph = await buildRuntimeGraph(new Map([["kokoro-payment/src/interfaces/http/server.ts", fixture]]));
    assert.notDeepEqual(graph, {
      files: RUNTIME_GRAPH_ALLOWLIST,
      externalImports: EXTERNAL_IMPORT_ALLOWLIST,
      terminalImports: TERMINAL_IMPORT_ALLOWLIST,
      dynamicImports: [],
    });
  }

  const existingReachableImport = `${server}\nimport type { PaymentProviderConfig } from "../../domain/provider.js";`;
  const directImports = importsFrom("kokoro-payment/src/interfaces/http/server.ts", existingReachableImport);
  assert.notDeepEqual(
    [...new Set(directImports.imports)].sort(),
    ACTIVE_IMPORT_ALLOWLIST.get("kokoro-payment/src/interfaces/http/server.ts"),
  );
});

test("production policy detector bears weight for every acquisition mutation and assembly class", () => {
  const fixtures = [
    ...[...MUTATING_REPOSITORY_MEMBERS].map((member) => `await repository.${member}({});`),
    ...[...FORBIDDEN_RUNTIME_IDENTIFIERS].map((identifier) => `void ${identifier};`),
    "void process.env.STRIPE_WEBHOOK_SECRET;",
    "void process.env['STRIPE_WEBHOOK_SECRET'];",
    "const env = process.env; void env['STRIPE_WEBHOOK_SECRET'];",
    "void globalThis.fetch;",
    "void globalThis['fetch'];",
    "const send = globalThis['fetch']; void send;",
    "const { createOrder: write } = repository; void write;",
    "const { ['createOrder']: write } = repository; void write;",
    "const get = Reflect.get; void get(repository, 'createOrder');",
    "void Reflect.get(repository, 'createOrder');",
    "app.post('/orders/reopen', async () => {});",
    "app.options('/orders', async () => {});",
    "app.post(buildRoute(), async () => {});",
    "app.route({ method: 'POST', url: '/orders/reopen', handler: async () => {} });",
  ];
  for (const fixture of fixtures) {
    assert.ok(productionSourceViolations("fixture.ts", fixture).length > 0, fixture);
  }
});

test("runtime content detector bears weight inside an otherwise allowed repository adapter", () => {
  for (const fixture of ["void fetch;", "void process.env.STRIPE_WEBHOOK_SECRET;", "void createWebhookProviderRegistry;"]) {
    assert.ok(
      runtimeContentViolations(
        "kokoro-payment/src/infrastructure/prisma/prisma-payment-repository.ts",
        fixture,
      ).length > 0,
      fixture,
    );
  }
});

test("template and seed detectors bear weight against provider, worker, secret, and mutation fixtures", () => {
  for (const fixture of [
    "KOKORO_PAYMENT_ENABLED_PROVIDERS=stripe",
    "KOKORO_PAYMENT_CONFIRM_SWEEP_INTERVAL_SECONDS=1",
    "KOKORO_PAYMENT_WEBHOOK_SECRET_STRIPE=secret",
    "STRIPE_WEBHOOK_SECRET=secret",
    "PAYPAL_WEBHOOK_SECRET=secret",
    "WEBHOOK_SECRET=secret",
    "KOKORO_PAYMENT_WEBHOOK_SIGNING_SECRET=secret",
    "STRIPE_WEBHOOK_SIGNING_SECRET=secret",
  ]) {
    assert.deepEqual(deploymentTemplateViolations(fixture), ["deprecated acquisition setting in .env.example"]);
  }
  for (const fixture of ["WEBHOOK_URL=https://example.test/hooks", "SECRET_ROTATION_ID=rotation-1"]) {
    assert.deepEqual(deploymentTemplateViolations(fixture), []);
  }
  for (const member of ["createOrder", "recordPaymentEvent", "upsertProvider", "upsertSubscription", "refundOrderAtomically"]) {
    assert.deepEqual(seedViolations(`await repo.${member}({});`), ["catalog seed contains acquisition mutation"]);
  }
});

test("read-boundary detector bears weight against full-repository and adapter-shape regressions", async () => {
  const routes = await readFile(resolve(ROOT, "kokoro-payment/src/interfaces/http/routes.ts"), "utf8");
  const adminRoutes = await readFile(resolve(ROOT, "kokoro-payment/src/interfaces/http/admin-routes.ts"), "utf8");
  const server = await readFile(resolve(ROOT, "kokoro-payment/src/interfaces/http/server.ts"), "utf8");
  const safeAdapter = `
    export const PAYMENT_READ_METHODS = ${JSON.stringify(PAYMENT_READ_METHODS)} as const;
    export function createPaymentReadRepository(repository) {
      return Object.freeze({
        listOrders: repository.listOrders,
        listPaymentEvents: repository.listPaymentEvents,
        listPlans: repository.listPlans,
        listProviders: repository.listProviders,
        listRefunds: repository.listRefunds,
        listSubscriptions: repository.listSubscriptions,
        readAdminStats: repository.readAdminStats,
      });
    }
  `;
  for (const adapter of [
    safeAdapter.replace("readAdminStats: repository.readAdminStats,", "createOrder: repository.createOrder,"),
    safeAdapter.replace('"readAdminStats"]', '"readAdminStats","createOrder"]'),
  ]) {
    assert.ok(paymentReadBoundaryViolations(new Map([
      ["routes", routes],
      ["adminRoutes", adminRoutes],
      ["adapter", adapter],
      ["server", server],
    ])).length > 0);
  }
});
