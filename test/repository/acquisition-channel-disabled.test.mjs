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

const ACTIVE_IMPORT_ALLOWLIST = new Map([
  ["kokoro-payment/src/config/env.ts", ["zod"]],
  ["kokoro-payment/src/domain/payment-lifecycle.ts", []],
  ["kokoro-payment/src/domain/payment.ts", ["./payment-lifecycle.js"]],
  ["kokoro-payment/src/domain/provider.ts", []],
  ["kokoro-payment/src/domain/read-repository.ts", ["./payment-lifecycle.js", "./payment.js", "./provider.js"]],
  ["kokoro-payment/src/infrastructure/prisma/prisma-client.ts", ["../../../generated/prisma/index.js"]],
  ["kokoro-payment/src/infrastructure/prisma/prisma-payment-read-repository.ts", ["../../../generated/prisma/index.js", "../../domain/payment-lifecycle.js", "../../domain/payment.js", "../../domain/provider.js", "../../domain/read-repository.js", "./prisma-client.js"]],
  ["kokoro-payment/src/interfaces/admin/manifest.ts", ["./payment-admin-contract.js"]],
  ["kokoro-payment/src/interfaces/admin/payment-admin-contract.ts", ["./schema.js"]],
  ["kokoro-payment/src/interfaces/admin/schema.ts", ["@kokoro/platform-kit"]],
  ["kokoro-payment/src/interfaces/http/admin-routes.ts", ["../../domain/read-repository.js", "../admin/manifest.js", "@kokoro/platform-kit", "fastify", "zod"]],
  ["kokoro-payment/src/interfaces/http/main.ts", ["../../config/env.js", "../../infrastructure/prisma/prisma-payment-read-repository.js", "./server.js", "@kokoro/platform-kit"]],
  ["kokoro-payment/src/interfaces/http/routes.ts", ["../../domain/read-repository.js", "@kokoro/platform-kit", "fastify"]],
  ["kokoro-payment/src/interfaces/http/server.ts", ["../../domain/read-repository.js", "./admin-routes.js", "./routes.js", "./webhook-routes.js", "@kokoro/platform-kit", "fastify"]],
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

const PAYMENT_CATALOG_READ_METHODS = ["listPlans"];
const PAYMENT_ADMIN_READ_METHODS = [
  "listOrders",
  "listPaymentEvents",
  "listPlans",
  "listProviders",
  "listRefunds",
  "listSubscriptions",
  "readAdminStats",
];
const PAYMENT_PRISMA_READ_CALLS = new Set([
  "this.#prisma.order.findMany",
  "this.#prisma.order.groupBy",
  "this.#prisma.paymentEvent.findMany",
  "this.#prisma.paymentProvider.findMany",
  "this.#prisma.plan.findMany",
  "this.#prisma.refund.findMany",
  "this.#prisma.subscription.findMany",
]);

const FORBIDDEN_RUNTIME_IDENTIFIERS = new Set([
  "PaymentService",
  "PaymentWebhookService",
  "Function",
  "callService",
  "createCreditGrantClient",
  "createCreditReverseClient",
  "createWebhookProviderRegistry",
  "enabledProviderKinds",
  "eval",
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

function httpSourceInventoryViolations(files) {
  const expected = new Set(HTTP_SOURCE_ALLOWLIST);
  const actual = new Set(files);
  return [
    ...HTTP_SOURCE_ALLOWLIST.filter((file) => !actual.has(file)).map((file) => `missing: ${file}`),
    ...files.filter((file) => !expected.has(file)).map((file) => `unexpected: ${file}`),
  ].sort();
}

function sourceFile(file, source) {
  return ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function sourceAnalysis(file, source) {
  const options = { noLib: true, noResolve: true, target: ts.ScriptTarget.Latest };
  const host = ts.createCompilerHost(options);
  const originalGetSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (requested, languageVersion, onError, shouldCreateNewSourceFile) =>
    requested === file
      ? sourceFile(file, source)
      : originalGetSourceFile(requested, languageVersion, onError, shouldCreateNewSourceFile);
  const program = ts.createProgram([file], options, host);
  const ast = program.getSourceFile(file);
  assert.ok(ast, `unable to analyze ${file}`);
  return { ast, checker: program.getTypeChecker() };
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
  const { ast, checker } = sourceAnalysis(file, source);
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
    if (!RUNTIME_ENV_READ_ALLOWLIST.has(file) && isProcessEnvAccess(node, checker)) {
      violations.push(`${file}: direct environment read ${node.getText(ast)}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return [...new Set(violations)].sort();
}

function isProcessEnvAccess(node, checker) {
  return (
    (ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "process" &&
      node.name.text === "env") ||
    (ts.isElementAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "process" &&
      evaluateConstantString(node.argumentExpression, checker) === "env")
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

function constantInitializer(identifier, checker) {
  const symbol = checker.getSymbolAtLocation(identifier);
  const declaration = symbol?.declarations?.find((candidate) =>
    ts.isVariableDeclaration(candidate) &&
    candidate.initializer &&
    ts.isVariableDeclarationList(candidate.parent) &&
    (candidate.parent.flags & ts.NodeFlags.Const) !== 0
  );
  return declaration && ts.isVariableDeclaration(declaration) ? { declaration, symbol } : undefined;
}

function evaluateConstantString(node, checker, resolving = new Set()) {
  if (!node) return undefined;
  const expression = unwrapExpression(node);
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
    return expression.text;
  }
  if (ts.isIdentifier(expression)) {
    const resolved = constantInitializer(expression, checker);
    if (!resolved || resolving.has(resolved.symbol)) return undefined;
    const next = new Set(resolving);
    next.add(resolved.symbol);
    return evaluateConstantString(resolved.declaration.initializer, checker, next);
  }
  if (
    ts.isBinaryExpression(expression) &&
    expression.operatorToken.kind === ts.SyntaxKind.PlusToken
  ) {
    const left = evaluateConstantString(expression.left, checker, resolving);
    const right = evaluateConstantString(expression.right, checker, resolving);
    return left === undefined || right === undefined ? undefined : left + right;
  }
  if (ts.isCallExpression(expression)) {
    const callee = unwrapExpression(expression.expression);
    if (ts.isPropertyAccessExpression(callee) && callee.name.text === "join") {
      const values = evaluateConstantStringArray(callee.expression, checker, resolving);
      const separator = expression.arguments[0]
        ? evaluateConstantString(expression.arguments[0], checker, resolving)
        : ",";
      return values && separator !== undefined ? values.join(separator) : undefined;
    }
  }
  return undefined;
}

function evaluateConstantStringArray(node, checker, resolving = new Set()) {
  const expression = unwrapExpression(node);
  if (ts.isIdentifier(expression)) {
    const resolved = constantInitializer(expression, checker);
    if (!resolved || resolving.has(resolved.symbol)) return undefined;
    const next = new Set(resolving);
    next.add(resolved.symbol);
    return evaluateConstantStringArray(resolved.declaration.initializer, checker, next);
  }
  if (!ts.isArrayLiteralExpression(expression)) return undefined;
  const values = expression.elements.map((element) => evaluateConstantString(element, checker, resolving));
  return values.every((value) => value !== undefined) ? values : undefined;
}

function bindingPropertyName(node, checker) {
  const property = node.propertyName ?? node.name;
  if (ts.isIdentifier(property) || ts.isStringLiteral(property) || ts.isNumericLiteral(property)) {
    return property.text;
  }
  if (ts.isComputedPropertyName(property)) {
    return evaluateConstantString(property.expression, checker);
  }
  return undefined;
}

function memberName(node, checker) {
  const expression = unwrapExpression(node);
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  if (ts.isElementAccessExpression(expression)) {
    return evaluateConstantString(expression.argumentExpression, checker);
  }
  return undefined;
}

function identifierInitializer(identifier, checker) {
  const resolved = constantInitializer(identifier, checker);
  return resolved?.declaration.initializer;
}

function isFastifyReceiver(node, checker, resolving = new Set()) {
  const expression = unwrapExpression(node);
  if (ts.isIdentifier(expression)) {
    if (["app", "instance"].includes(expression.text)) return true;
    const symbol = checker.getSymbolAtLocation(expression);
    if (!symbol || resolving.has(symbol)) return false;
    const initializer = identifierInitializer(expression, checker);
    if (!initializer) return false;
    const next = new Set(resolving);
    next.add(symbol);
    return isFastifyReceiver(initializer, checker, next);
  }
  return false;
}

function routeRegistrar(node, checker, resolving = new Set()) {
  const expression = unwrapExpression(node);
  if (ts.isIdentifier(expression)) {
    const symbol = checker.getSymbolAtLocation(expression);
    if (!symbol || resolving.has(symbol)) return undefined;
    const initializer = identifierInitializer(expression, checker);
    if (!initializer) return undefined;
    const next = new Set(resolving);
    next.add(symbol);
    return routeRegistrar(initializer, checker, next);
  }
  if (ts.isCallExpression(expression) && memberName(expression.expression, checker) === "bind") {
    const bindTarget = unwrapExpression(expression.expression).expression;
    return routeRegistrar(bindTarget, checker, resolving);
  }
  if (!ts.isPropertyAccessExpression(expression) && !ts.isElementAccessExpression(expression)) {
    return undefined;
  }
  const method = memberName(expression, checker)?.toUpperCase();
  if (!method) return undefined;
  const receiver = unwrapExpression(expression).expression;
  if (!isFastifyReceiver(receiver, checker)) return undefined;
  return { method, pathIndex: 0 };
}

function recordRouteViolation(file, ast, checker, call, registration, violations) {
  const { method, pathIndex } = registration;
  if (method === "ROUTE") {
    violations.push(`${file}: generic route registration is not allowed`);
    return;
  }
  if (!HTTP_REGISTRATION_METHODS.has(method)) return;
  const path = call.arguments[pathIndex];
  const literalPath = path ? evaluateConstantString(path, checker) : undefined;
  if (literalPath !== undefined) {
    const route = `${method} ${literalPath}`;
    if (!ALLOWED_LITERAL_ROUTES.has(route)) violations.push(`${file}: unapproved literal route ${route}`);
    return;
  }
  const dynamicRegistration = `${file}:${method}:${path?.getText(ast) ?? "<missing>"}`;
  if (!ALLOWED_DYNAMIC_ROUTE_REGISTRATIONS.has(dynamicRegistration)) {
    violations.push(`${file}: unapproved dynamic route ${dynamicRegistration}`);
  }
}

function productionSourceViolations(file, source) {
  const violations = runtimeContentViolations(file, source);
  const { ast, checker } = sourceAnalysis(file, source);
  const visit = (node) => {
    if (ts.isBindingElement(node)) {
      const member = bindingPropertyName(node, checker);
      if (member && MUTATING_REPOSITORY_MEMBERS.has(member)) {
        violations.push(`${file}: mutating member ${member}`);
      }
    }
    if (ts.isPropertyAccessExpression(node) && MUTATING_REPOSITORY_MEMBERS.has(node.name.text)) {
      violations.push(`${file}: mutating member ${node.name.text}`);
    }
    if (ts.isElementAccessExpression(node)) {
      const member = evaluateConstantString(node.argumentExpression, checker);
      if (member && MUTATING_REPOSITORY_MEMBERS.has(member)) {
        violations.push(`${file}: mutating member ${member}`);
      }
    }
    if (ts.isCallExpression(node)) {
      const callee = unwrapExpression(node.expression);
      if (
        (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) &&
        ["call", "apply"].includes(memberName(callee, checker) ?? "")
      ) {
        const target = routeRegistrar(callee.expression, checker);
        if (target) violations.push(`${file}: indirect route registration is not allowed`);
      }
      const registration = routeRegistrar(node.expression, checker);
      if (registration) recordRouteViolation(file, ast, checker, node, registration, violations);
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

function paymentRuntimeCredentialViolations(source) {
  const violations = [];
  if (!source.includes("DATABASE_URL_PAYMENT_READ")) {
    violations.push("missing payment read credential");
  }
  if (/^\s*(?:-\s+name:\s+|key:\s+)?DATABASE_URL_PAYMENT(?:\s*:|\s*$)/mu.test(source)) {
    violations.push("payment runtime references migration/write credential");
  }
  return violations;
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

function expressionMemberPath(node, checker, resolving = new Set()) {
  const expression = unwrapExpression(node);
  if (expression.kind === ts.SyntaxKind.ThisKeyword) return ["this"];
  if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) {
    const base = expressionMemberPath(expression.expression, checker, resolving);
    const name = memberName(expression, checker);
    return base && name ? [...base, name] : undefined;
  }
  if (ts.isIdentifier(expression)) {
    const symbol = checker.getSymbolAtLocation(expression);
    if (!symbol || resolving.has(symbol)) return undefined;
    const initializer = identifierInitializer(expression, checker);
    if (!initializer) return undefined;
    const next = new Set(resolving);
    next.add(symbol);
    return expressionMemberPath(initializer, checker, next);
  }
  return undefined;
}

function prismaReadAdapterViolations(source) {
  const violations = [];
  const { ast, checker } = sourceAnalysis("prisma-payment-read-repository.ts", source);
  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && node.initializer) {
      const path = expressionMemberPath(node.initializer, checker);
      if (path?.[0] === "this" && ["#prisma", "prisma"].includes(path[1])) {
        violations.push(`adapter: raw Prisma alias ${node.name.getText(ast)}`);
      }
    }
    if (ts.isCallExpression(node)) {
      const path = expressionMemberPath(node.expression, checker);
      if (path?.[0] === "this" && ["#prisma", "prisma"].includes(path[1])) {
        const call = path.join(".");
        if (!PAYMENT_PRISMA_READ_CALLS.has(call)) {
          violations.push(`adapter: forbidden Prisma capability ${call}`);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return violations;
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
  const declaredMethods = new Map();
  const interfaceMethods = new Map();
  const interfaceHeritage = new Map();
  const visitPort = (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      ["PAYMENT_CATALOG_READ_METHODS", "PAYMENT_ADMIN_READ_METHODS"].includes(node.name.text)
    ) {
      let initializer = node.initializer;
      if (initializer && ts.isAsExpression(initializer)) initializer = initializer.expression;
      if (initializer && ts.isArrayLiteralExpression(initializer)) {
        declaredMethods.set(
          node.name.text,
          initializer.elements.filter(ts.isStringLiteral).map((entry) => entry.text).sort(),
        );
      }
    }
    if (
      ts.isInterfaceDeclaration(node) &&
      ["PaymentCatalogRepository", "PaymentAdminRepository"].includes(node.name.text)
    ) {
      const methods = [];
      for (const member of node.members) {
        if (ts.isMethodSignature(member) && member.name) methods.push(member.name.getText(portAst));
      }
      interfaceMethods.set(node.name.text, methods.sort());
      interfaceHeritage.set(
        node.name.text,
        node.heritageClauses?.flatMap((clause) => clause.types.map((type) => type.getText(portAst))) ?? [],
      );
    }
    ts.forEachChild(node, visitPort);
  };
  visitPort(portAst);

  const adapterAst = sourceFile("prisma-payment-read-repository.ts", adapter);
  let exposedMethods = [];
  let adapterImplementsReadPort = false;
  let hasRuntimePrivatePrisma = false;
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
      hasRuntimePrivatePrisma = node.members.some(
        (member) => ts.isPropertyDeclaration(member) && ts.isPrivateIdentifier(member.name) && member.name.text === "#prisma",
      );
    }
    ts.forEachChild(node, visitAdapter);
  };
  visitAdapter(adapterAst);
  for (const [constantName, interfaceName, expected] of [
    ["PAYMENT_CATALOG_READ_METHODS", "PaymentCatalogRepository", PAYMENT_CATALOG_READ_METHODS],
    ["PAYMENT_ADMIN_READ_METHODS", "PaymentAdminRepository", PAYMENT_ADMIN_READ_METHODS],
  ]) {
    if (JSON.stringify(declaredMethods.get(constantName)) !== JSON.stringify(expected)) {
      violations.push(`port: ${constantName} must be exact`);
    }
    if (JSON.stringify(interfaceMethods.get(interfaceName)) !== JSON.stringify(expected)) {
      violations.push(`port: ${interfaceName} must be exact`);
    }
    if ((interfaceHeritage.get(interfaceName) ?? []).length > 0) {
      violations.push(`port: ${interfaceName} must not inherit hidden capabilities`);
    }
  }
  if (JSON.stringify(exposedMethods) !== JSON.stringify(PAYMENT_ADMIN_READ_METHODS)) {
    violations.push("adapter: class must implement exactly the read methods");
  }
  if (!adapterImplementsReadPort) {
    violations.push("adapter: PaymentAdminRepository implementation is required");
  }
  if (!hasRuntimePrivatePrisma) violations.push("adapter: Prisma client must use a JavaScript #private field");
  violations.push(...prismaReadAdapterViolations(adapter));
  for (const [name, source] of [["port", port], ["adapter", adapter], ["routes", routes], ["admin-routes", adminRoutes], ["server", server]]) {
    for (const forbidden of ["PaymentRepository", "PrismaPaymentRepository"]) {
      if (source.includes(forbidden)) violations.push(`${name}: forbidden full capability ${forbidden}`);
    }
  }
  if (!server.includes("readCapabilities: PaymentReadCapabilities")) {
    violations.push("server: exact PaymentReadCapabilities input is required");
  }
  if (server.includes("PrismaClient") || server.includes("createPrismaClient") || server.includes("PrismaPaymentReadRepository")) {
    violations.push("server: raw Prisma assembly is forbidden");
  }
  if (!server.includes("options.readCapabilities.catalog") || !server.includes("options.readCapabilities.admin")) {
    violations.push("server: catalogue and admin routes require separate capabilities");
  }
  return violations.sort();
}

function seedViolations(source) {
  return FORBIDDEN_SEED_MEMBER.test(source) ? ["catalog seed contains acquisition mutation"] : [];
}

test("production HTTP source inventory is closed", async () => {
  assert.deepEqual(httpSourceInventoryViolations(
    await listTypeScriptFiles("kokoro-payment/src/interfaces/http"),
  ), []);
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
  const graph = await buildRuntimeGraph();
  for (const file of graph.files) {
    violations.push(...productionSourceViolations(file, await readFile(resolve(ROOT, file), "utf8")));
  }
  assert.deepEqual(violations, []);
});

test("every runtime-reachable source is free of provider egress, SDK assembly, and secret reads", async () => {
  const violations = [];
  const graph = await buildRuntimeGraph();
  for (const file of graph.files) {
    violations.push(...runtimeContentViolations(file, await readFile(resolve(ROOT, file), "utf8")));
  }
  assert.deepEqual(violations, []);
});

test("every active composition file has an exact direct-import allowlist", async () => {
  const graph = await buildRuntimeGraph();
  assert.deepEqual([...ACTIVE_IMPORT_ALLOWLIST.keys()].sort(), graph.files);
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

test("payment deployments require the dedicated read credential without write fallback", async () => {
  for (const file of [
    "deploy/docker-compose.services.yml",
    "deploy/k8s/platform-services.example.yaml",
  ]) {
    assert.deepEqual(
      paymentRuntimeCredentialViolations(await readFile(resolve(ROOT, file), "utf8")),
      [],
      file,
    );
  }
});

test("HTTP inventory detector bears weight against a new production route file", async () => {
  assert.deepEqual(
    httpSourceInventoryViolations([
      ...HTTP_SOURCE_ALLOWLIST,
      "kokoro-payment/src/interfaces/http/acquisition-routes.ts",
    ]),
    ["unexpected: kokoro-payment/src/interfaces/http/acquisition-routes.ts"],
  );
  assert.deepEqual(
    httpSourceInventoryViolations(
      HTTP_SOURCE_ALLOWLIST.filter((file) => !file.endsWith("/routes.ts")),
    ),
    ["missing: kokoro-payment/src/interfaces/http/routes.ts"],
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
    "const register = app.post.bind(app); register('/orders/reopen', async () => {});",
    "if (isProductionEnv()) { const register = app.post.bind(app); register('/orders/reopen', async () => {}); }",
    "app.post.call(app, '/orders/reopen', async () => {});",
    "app.post.apply(app, ['/orders/reopen', async () => {}]);",
    "eval(\"import('../../application/payment-service.js')\");",
    "new Function(\"return import('../../application/payment-service.js')\");",
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

test("constant-folding policy detector resolves the lexical binding at each access", () => {
  const unsafeOuterBinding = `
    const member = "createOrder";
    function harmless() { const member = "listPlans"; return repository[member]; }
    void repository[member];
  `;
  assert.ok(productionSourceViolations("fixture.ts", unsafeOuterBinding).length > 0);

  const safeOuterBinding = `
    const member = "listPlans";
    function forbiddenInner() { const member = "createOrder"; return repository[member]; }
    void repository[member];
  `;
  assert.deepEqual(
    productionSourceViolations("fixture.ts", safeOuterBinding),
    ["fixture.ts: mutating member createOrder"],
  );
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
  assert.deepEqual(paymentRuntimeCredentialViolations("KOKORO_PAYMENT_PORT: 4241"), [
    "missing payment read credential",
  ]);
  assert.deepEqual(
    paymentRuntimeCredentialViolations(
      "DATABASE_URL_PAYMENT_READ: read-only\nDATABASE_URL_PAYMENT: write",
    ),
    ["payment runtime references migration/write credential"],
  );
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
    ["adapter-extra-method", "adapter", adapter.replace("  async listPlans", "  async createOrder() {}\n\n  async listPlans")],
    ["adapter-direct-write", "adapter", adapter.replace("this.#prisma.plan.findMany", "this.#prisma.plan.create")],
    ["port-constant", "port", port.replace('  "readAdminStats",', '  "createOrder",\n  "readAdminStats",')],
    ["server-raw-client", "server", server.replace("readCapabilities: PaymentReadCapabilities", "prisma: PrismaClient")],
    ["route-full-port", "routes", routes.replace("../../domain/read-repository.js", "../../domain/repository.js")],
    ["adapter-client-alias", "adapter", adapter.replace(
      "const plans = await this.#prisma.plan.findMany(",
      "const db = this.#prisma;\n    const plans = await db.plan.create(",
    )],
    ["adapter-delegate-alias", "adapter", adapter.replace(
      "const plans = await this.#prisma.plan.findMany(",
      "const plansDelegate = this.#prisma.plan;\n    const plans = await plansDelegate.create(",
    )],
    ["port-capability-transfer", "port", port
      .replace(
        "  listPlans(siteId?: string, options?: ListOptions): Promise<Plan[]>;\n}\n\nexport interface PaymentAdminRepository",
        "  listPlans(siteId?: string, options?: ListOptions): Promise<Plan[]>;\n  listProviders(): Promise<PaymentProviderConfig[]>;\n}\n\nexport interface PaymentAdminRepository",
      )
      .replace(
        "  listPaymentEvents(): Promise<PaymentEvent[]>;\n  listProviders(): Promise<PaymentProviderConfig[]>;",
        "  listPaymentEvents(): Promise<PaymentEvent[]>;",
      )],
  ];
  for (const [label, key, source] of mutations) {
    const fixture = new Map(safe);
    fixture.set(key, source);
    assert.ok(paymentReadBoundaryViolations(new Map([
      ...fixture,
    ])).length > 0, label);
  }
});
