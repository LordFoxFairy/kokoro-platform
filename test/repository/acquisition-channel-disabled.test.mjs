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
  "kokoro-payment/src/interfaces/http/routes.ts",
  "kokoro-payment/src/interfaces/http/schemas.ts",
  "kokoro-payment/src/interfaces/http/server.ts",
  "kokoro-payment/src/interfaces/http/webhook-routes.ts",
];

const RUNTIME_ROOTS = [
  "kokoro-payment/src/interfaces/http/main.ts",
];

const RUNTIME_GRAPH_ALLOWLIST = [
  "kokoro-payment/src/config/env.ts",
  "kokoro-payment/src/domain/payment-lifecycle.ts",
  "kokoro-payment/src/domain/payment.ts",
  "kokoro-payment/src/domain/provider.ts",
  "kokoro-payment/src/domain/read-repository.ts",
  "kokoro-payment/src/infrastructure/prisma/prisma-client.ts",
  "kokoro-payment/src/infrastructure/prisma/prisma-payment-read-repository.ts",
  "kokoro-payment/src/interfaces/admin/manifest.ts",
  "kokoro-payment/src/interfaces/admin/payment-admin-contract.ts",
  "kokoro-payment/src/interfaces/admin/schema.ts",
  "kokoro-payment/src/interfaces/http/admin-routes.ts",
  "kokoro-payment/src/interfaces/http/main.ts",
  "kokoro-payment/src/interfaces/http/routes.ts",
  "kokoro-payment/src/interfaces/http/server.ts",
  "kokoro-payment/src/interfaces/http/webhook-routes.ts",
];

const EXTERNAL_IMPORT_ALLOWLIST = ["@kokoro/platform-kit", "fastify", "zod"];
const TERMINAL_IMPORT_ALLOWLIST = ["kokoro-payment/generated/prisma/index.js"];

const ACTIVE_POLICY_FILES = [
  "kokoro-payment/src/domain/read-repository.ts",
  "kokoro-payment/src/infrastructure/prisma/prisma-payment-read-repository.ts",
  "kokoro-payment/src/interfaces/http/admin-routes.ts",
  "kokoro-payment/src/interfaces/http/main.ts",
  "kokoro-payment/src/interfaces/http/routes.ts",
  "kokoro-payment/src/interfaces/http/server.ts",
  "kokoro-payment/src/interfaces/http/webhook-routes.ts",
];

const ACTIVE_IMPORT_ALLOWLIST = new Map([
  ["kokoro-payment/src/domain/read-repository.ts", ["./payment-lifecycle.js", "./payment.js", "./provider.js"]],
  ["kokoro-payment/src/infrastructure/prisma/prisma-payment-read-repository.ts", ["../../../generated/prisma/index.js", "../../domain/payment-lifecycle.js", "../../domain/payment.js", "../../domain/provider.js", "../../domain/read-repository.js"]],
  ["kokoro-payment/src/interfaces/http/admin-routes.ts", ["../../domain/read-repository.js", "../admin/manifest.js", "@kokoro/platform-kit", "fastify", "zod"]],
  ["kokoro-payment/src/interfaces/http/main.ts", ["../../config/env.js", "./server.js", "@kokoro/platform-kit"]],
  ["kokoro-payment/src/interfaces/http/routes.ts", ["../../domain/read-repository.js", "@kokoro/platform-kit", "fastify"]],
  ["kokoro-payment/src/interfaces/http/server.ts", ["../../../generated/prisma/index.js", "../../infrastructure/prisma/prisma-client.js", "../../infrastructure/prisma/prisma-payment-read-repository.js", "./admin-routes.js", "./routes.js", "./webhook-routes.js", "@kokoro/platform-kit", "fastify"]],
  ["kokoro-payment/src/interfaces/http/webhook-routes.ts", ["./routes.js", "@kokoro/platform-kit", "fastify"]],
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
const PAYMENT_PRISMA_READ_CALLS = new Set([
  "this.prisma.order.findMany",
  "this.prisma.order.groupBy",
  "this.prisma.paymentEvent.findMany",
  "this.prisma.paymentProvider.findMany",
  "this.prisma.plan.findMany",
  "this.prisma.refund.findMany",
  "this.prisma.subscription.findMany",
]);

const FORBIDDEN_RUNTIME_IDENTIFIERS = new Set([
  "PaymentService",
  "PaymentWebhookService",
  "callService",
  "createCreditGrantClient",
  "createCreditReverseClient",
  "createWebhookProviderRegistry",
  "enabledProviderKinds",
  "fetch",
  "global",
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
    if (
      !RUNTIME_ENV_READ_ALLOWLIST.has(file) &&
      ts.isIdentifier(node) &&
      node.text === "process"
    ) {
      violations.push(`${file}: direct environment capability ${node.getText(ast)}`);
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
    (ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "process" &&
      node.name.text === "env") ||
    (ts.isElementAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "process" &&
      evaluateConstantString(node.argumentExpression, new Map()) === "env")
  );
}

function unwrapExpression(node) {
  let current = node;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function evaluateConstantString(node, constants, resolving = new Set()) {
  if (!node) return undefined;
  const expression = unwrapExpression(node);
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
    return expression.text;
  }
  if (ts.isIdentifier(expression)) {
    if (resolving.has(expression.text)) return undefined;
    const initializer = constants.get(expression.text);
    if (!initializer) return undefined;
    const next = new Set(resolving);
    next.add(expression.text);
    return evaluateConstantString(initializer, constants, next);
  }
  if (
    ts.isBinaryExpression(expression) &&
    expression.operatorToken.kind === ts.SyntaxKind.PlusToken
  ) {
    const left = evaluateConstantString(expression.left, constants, resolving);
    const right = evaluateConstantString(expression.right, constants, resolving);
    return left === undefined || right === undefined ? undefined : left + right;
  }
  if (ts.isCallExpression(expression)) {
    const callee = unwrapExpression(expression.expression);
    if (ts.isPropertyAccessExpression(callee) && callee.name.text === "join") {
      const values = evaluateConstantStringArray(callee.expression, constants, resolving);
      const separator = expression.arguments[0]
        ? evaluateConstantString(expression.arguments[0], constants, resolving)
        : ",";
      return values && separator !== undefined ? values.join(separator) : undefined;
    }
  }
  return undefined;
}

function evaluateConstantStringArray(node, constants, resolving = new Set()) {
  const expression = unwrapExpression(node);
  if (ts.isIdentifier(expression)) {
    if (resolving.has(expression.text)) return undefined;
    const initializer = constants.get(expression.text);
    if (!initializer) return undefined;
    const next = new Set(resolving);
    next.add(expression.text);
    return evaluateConstantStringArray(initializer, constants, next);
  }
  if (!ts.isArrayLiteralExpression(expression)) return undefined;
  const values = expression.elements.map((element) => evaluateConstantString(element, constants, resolving));
  return values.every((value) => value !== undefined) ? values : undefined;
}

function collectConstantInitializers(ast) {
  const constants = new Map();
  const visit = (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isVariableDeclarationList(node.parent) &&
      (node.parent.flags & ts.NodeFlags.Const) !== 0
    ) {
      constants.set(node.name.text, node.initializer);
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return constants;
}

function bindingPropertyName(node, constants) {
  const property = node.propertyName ?? node.name;
  if (ts.isIdentifier(property) || ts.isStringLiteral(property) || ts.isNumericLiteral(property)) {
    return property.text;
  }
  if (ts.isComputedPropertyName(property)) {
    return evaluateConstantString(property.expression, constants);
  }
  return undefined;
}

function productionSourceViolations(file, source) {
  const violations = runtimeContentViolations(file, source);
  const ast = sourceFile(file, source);
  const constants = collectConstantInitializers(ast);
  const visit = (node) => {
    if (ts.isBindingElement(node)) {
      const member = bindingPropertyName(node, constants);
      if (member && MUTATING_REPOSITORY_MEMBERS.has(member)) {
        violations.push(`${file}: mutating member ${member}`);
      }
    }
    if (ts.isPropertyAccessExpression(node) && MUTATING_REPOSITORY_MEMBERS.has(node.name.text)) {
      violations.push(`${file}: mutating member ${node.name.text}`);
    }
    if (ts.isElementAccessExpression(node)) {
      const member = evaluateConstantString(node.argumentExpression, constants);
      if (member && MUTATING_REPOSITORY_MEMBERS.has(member)) {
        violations.push(`${file}: mutating member ${member}`);
      }
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      ["app", "instance"].includes(node.expression.expression.text)
    ) {
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
    const match = /^\s*([^#=\s]+)\s*=/u.exec(line);
    if (!match) continue;
    const key = match[1].normalize("NFKC").toUpperCase().replace(/[^A-Z0-9]/gu, "");
    if (
      (key.includes("WEBHOOK") && key.includes("SECRET")) ||
      ["KOKOROUSERBASEURL", "KOKOROMODELBASEURL", "KOKOROCREDITBASEURL", "KOKOROPAYMENTBASEURL"].includes(key) ||
      ["KOKOROPAYMENTENABLEDPROVIDERS", "KOKOROPAYMENTALIPAYPUBLICKEY", "KOKOROPAYMENTWECHATPLATFORMCERT"].includes(key) ||
      key.startsWith("KOKOROPAYMENTCONFIRM")
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
  const port = sources.get("port") ?? "";
  const adapter = sources.get("adapter") ?? "";
  const server = sources.get("server") ?? "";

  for (const [name, source, functionName, expectedType] of [
    ["routes", routes, "registerPaymentRoutes", "PaymentCatalogRepository"],
    ["admin-routes", adminRoutes, "registerPaymentAdminRoutes", "PaymentAdminRepository"],
  ]) {
    const parsed = importsFrom(`${name}.ts`, source);
    if (!parsed.imports.includes("../../domain/read-repository.js")) {
      violations.push(`${name}: named read repository port import is required`);
    }
    if (functionParameterType(source, functionName, 1) !== expectedType) {
      violations.push(`${name}: repository parameter must be ${expectedType}`);
    }
  }

  const portAst = sourceFile("read-repository.ts", port);
  let declaredMethods = [];
  const interfaceMethods = new Set();
  const visitPort = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "PAYMENT_READ_METHODS") {
      let initializer = node.initializer;
      if (initializer && ts.isAsExpression(initializer)) initializer = initializer.expression;
      if (initializer && ts.isArrayLiteralExpression(initializer)) {
        declaredMethods = initializer.elements.filter(ts.isStringLiteral).map((entry) => entry.text).sort();
      }
    }
    if (
      ts.isInterfaceDeclaration(node) &&
      ["PaymentCatalogRepository", "PaymentAdminRepository"].includes(node.name.text)
    ) {
      for (const member of node.members) {
        if (ts.isMethodSignature(member) && member.name) interfaceMethods.add(member.name.getText(portAst));
      }
    }
    ts.forEachChild(node, visitPort);
  };
  visitPort(portAst);

  const adapterAst = sourceFile("prisma-payment-read-repository.ts", adapter);
  let exposedMethods = [];
  let adapterImplementsReadPort = false;
  const prismaCalls = new Set();
  const visitAdapter = (node) => {
    if (ts.isClassDeclaration(node) && node.name?.text === "PrismaPaymentReadRepository") {
      exposedMethods = node.members
        .filter(ts.isMethodDeclaration)
        .map((member) => member.name.getText(adapterAst))
        .sort();
      adapterImplementsReadPort = node.heritageClauses?.some(
        (clause) => clause.token === ts.SyntaxKind.ImplementsKeyword &&
          clause.types.some((type) => type.expression.getText(adapterAst) === "PaymentAdminRepository"),
      ) ?? false;
    }
    if (ts.isCallExpression(node)) {
      const callee = node.expression.getText(adapterAst);
      if (callee.startsWith("this.prisma.")) prismaCalls.add(callee);
    }
    ts.forEachChild(node, visitAdapter);
  };
  visitAdapter(adapterAst);
  if (JSON.stringify(declaredMethods) !== JSON.stringify(PAYMENT_READ_METHODS)) {
    violations.push("port: PAYMENT_READ_METHODS must be exact");
  }
  if (JSON.stringify([...interfaceMethods].sort()) !== JSON.stringify(PAYMENT_READ_METHODS)) {
    violations.push("port: interfaces must expose exactly the read methods");
  }
  if (JSON.stringify(exposedMethods) !== JSON.stringify(PAYMENT_READ_METHODS)) {
    violations.push("adapter: class must implement exactly the read methods");
  }
  if (!adapterImplementsReadPort) {
    violations.push("adapter: PaymentAdminRepository implementation is required");
  }
  for (const call of prismaCalls) {
    if (!PAYMENT_PRISMA_READ_CALLS.has(call)) violations.push(`adapter: forbidden Prisma capability ${call}`);
  }
  for (const [name, source] of [["port", port], ["adapter", adapter], ["routes", routes], ["admin-routes", adminRoutes], ["server", server]]) {
    for (const forbidden of ["PaymentRepository", "PrismaPaymentRepository"]) {
      if (source.includes(forbidden)) violations.push(`${name}: forbidden full capability ${forbidden}`);
    }
  }
  if (!server.includes("const repository = new PrismaPaymentReadRepository(prisma);")) {
    violations.push("server: exact read adapter construction is required");
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
      ["port", await readFile(resolve(ROOT, "kokoro-payment/src/domain/read-repository.ts"), "utf8")],
      ["adapter", await readFile(resolve(ROOT, "kokoro-payment/src/infrastructure/prisma/prisma-payment-read-repository.ts"), "utf8")],
      ["server", await readFile(resolve(ROOT, "kokoro-payment/src/interfaces/http/server.ts"), "utf8")],
    ])),
    [],
  );
});

test("production HTTP tree and runtime graph never import full Payment write capabilities", async () => {
  const violations = [];
  for (const file of await listTypeScriptFiles("kokoro-payment/src/interfaces/http")) {
    const source = await readFile(resolve(ROOT, file), "utf8");
    for (const capability of ["PaymentRepository", "PrismaPaymentRepository"]) {
      if (source.includes(capability)) violations.push(`${file}: ${capability}`);
    }
  }
  const graph = await buildRuntimeGraph();
  for (const file of [
    "kokoro-payment/src/domain/repository.ts",
    "kokoro-payment/src/infrastructure/prisma/prisma-payment-repository.ts",
  ]) {
    if (graph.files.includes(file)) violations.push(`runtime graph: ${file}`);
  }
  assert.deepEqual(violations, []);
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
    "const member = ['create', 'Order'].join(''); const { [member]: write } = repository; void write;",
    "const member = ['create', 'Order'].join(''); void repository[member];",
    "const member = 'create' + 'Order'; void repository[member];",
    "void global['fe' + 'tch'];",
    "const get = Reflect.get; void get(repository, 'createOrder');",
    "const member = ['create', 'Order'].join(''); void Reflect.get(repository, member);",
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

test("constant-folding policy detector permits dynamically composed read-only method names", () => {
  for (const fixture of [
    "const member = ['list', 'Plans'].join(''); void repository[member];",
    "const { [['list', 'Plans'].join('')]: read } = repository; void read;",
    "const label = 'web' + 'hook'; void metadata[label];",
  ]) {
    assert.deepEqual(productionSourceViolations("fixture.ts", fixture), [], fixture);
  }
});

test("runtime content detector bears weight inside an otherwise allowed repository adapter", () => {
  for (const fixture of ["void fetch;", "void process.env.STRIPE_WEBHOOK_SECRET;", "void createWebhookProviderRegistry;"]) {
    assert.ok(
      runtimeContentViolations(
        "kokoro-payment/src/infrastructure/prisma/prisma-payment-read-repository.ts",
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
    "stripe_web_hook_secret=secret",
    "STRIPE-WEB-HOOK-SIGNING-SECRET=secret",
    "secret.web.hook=secret",
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
  const port = await readFile(resolve(ROOT, "kokoro-payment/src/domain/read-repository.ts"), "utf8");
  const adapter = await readFile(resolve(ROOT, "kokoro-payment/src/infrastructure/prisma/prisma-payment-read-repository.ts"), "utf8");
  const server = await readFile(resolve(ROOT, "kokoro-payment/src/interfaces/http/server.ts"), "utf8");
  const safe = new Map([
    ["routes", routes],
    ["adminRoutes", adminRoutes],
    ["port", port],
    ["adapter", adapter],
    ["server", server],
  ]);
  const mutations = [
    ["adapter", adapter.replace("  async listPlans", "  async createOrder() {}\n\n  async listPlans")],
    ["adapter", adapter.replace("this.prisma.plan.findMany", "this.prisma.plan.create")],
    ["port", port.replace('  "readAdminStats",', '  "createOrder",\n  "readAdminStats",')],
    ["server", server.replaceAll("PrismaPaymentReadRepository", "PrismaPaymentRepository")],
    ["routes", routes.replace("../../domain/read-repository.js", "../../domain/repository.js")],
  ];
  for (const [key, source] of mutations) {
    const fixture = new Map(safe);
    fixture.set(key, source);
    assert.ok(paymentReadBoundaryViolations(new Map([
      ...fixture,
    ])).length > 0, key);
  }
});
