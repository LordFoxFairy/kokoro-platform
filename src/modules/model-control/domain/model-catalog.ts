import { createHash } from "node:crypto";

export const modelProducts = ["chat", "music", "image", "video"] as const;
export type ModelProduct = (typeof modelProducts)[number];
export type ModelRouteRole = "main" | "generation";
export type ProviderAdapterKind = "litellm" | "direct";

export interface CanonicalProvider {
  readonly key: string;
  readonly provider: string;
  readonly accountKey: string;
  readonly secretRef: string;
  readonly adapterKind: ProviderAdapterKind;
  readonly priority: number;
}
export interface CanonicalModelDefinition {
  readonly key: string;
  readonly displayName: string;
  readonly inputModalities: readonly string[];
  readonly outputModalities: readonly string[];
  readonly capabilities: readonly string[];
  readonly contextWindow: number | null;
  readonly enabled: boolean;
}
export interface CanonicalProviderModelBinding {
  readonly key: string;
  readonly modelKey: string;
  readonly providerKey: string;
  readonly upstreamModel: string;
  readonly gatewayModelName: string;
  readonly priority: number;
  readonly enabled: boolean;
}
export interface CanonicalProductRoute {
  readonly product: ModelProduct;
  readonly role: ModelRouteRole;
  readonly modelKey: string;
  readonly position: number;
  readonly requiredCapabilities: readonly string[];
}
export interface CanonicalModelInventory {
  readonly schemaVersion: 1;
  readonly source: {
    readonly kind: "legacy-kokoro-model" | "platform-native";
    readonly reference: string;
  };
  readonly providers: readonly CanonicalProvider[];
  readonly models: readonly CanonicalModelDefinition[];
  readonly bindings: readonly CanonicalProviderModelBinding[];
  readonly productRoutes: readonly CanonicalProductRoute[];
}
export interface CanonicalizedModelInventory {
  readonly document: CanonicalModelInventory;
  readonly canonicalJson: string;
  readonly digest: string;
  readonly counts: {
    readonly providers: number;
    readonly models: number;
    readonly bindings: number;
    readonly productRoutes: number;
  };
}

export function canonicalizeModelInventory(
  input: CanonicalModelInventory,
): CanonicalizedModelInventory {
  if (input.schemaVersion !== 1) throw new Error("MODEL_INVENTORY_VERSION_UNSUPPORTED");
  const providers = sortUnique(input.providers, (item) => item.key, "MODEL_PROVIDER_DUPLICATE").map(
    (item) =>
      Object.freeze({
        ...item,
        key: identifier(item.key),
        provider: identifier(item.provider),
        accountKey: identifier(item.accountKey),
        secretRef: secretReference(item.secretRef),
        priority: boundedPosition(item.priority),
        adapterKind: adapterKind(item.adapterKind),
      }),
  );
  const providerKeys = new Set(providers.map((item) => item.key));
  const models = sortUnique(input.models, (item) => item.key, "MODEL_DEFINITION_DUPLICATE").map(
    (item) =>
      Object.freeze({
        ...item,
        key: identifier(item.key),
        displayName: text(item.displayName),
        inputModalities: sortedStrings(item.inputModalities),
        outputModalities: sortedStrings(item.outputModalities),
        capabilities: sortedStrings(item.capabilities),
        contextWindow:
          item.contextWindow === null
            ? null
            : positiveInteger(item.contextWindow, "MODEL_CONTEXT_WINDOW_INVALID"),
      }),
  );
  const modelKeys = new Set(models.map((item) => item.key));
  const bindings = sortUnique(input.bindings, (item) => item.key, "MODEL_BINDING_DUPLICATE").map(
    (item) =>
      Object.freeze({
        ...item,
        key: identifier(item.key),
        modelKey: member(item.modelKey, modelKeys, "MODEL_BINDING_MODEL_UNKNOWN"),
        providerKey: member(item.providerKey, providerKeys, "MODEL_BINDING_PROVIDER_UNKNOWN"),
        upstreamModel: text(item.upstreamModel),
        gatewayModelName: gatewayName(item.gatewayModelName),
        priority: boundedPosition(item.priority),
      }),
  );
  assertNoDuplicate(
    bindings,
    (item) => `${item.modelKey}:${item.providerKey}:${item.upstreamModel}`,
    "MODEL_BINDING_TARGET_DUPLICATE",
  );
  assertNoDuplicate(bindings, (item) => item.gatewayModelName, "MODEL_GATEWAY_NAME_DUPLICATE");
  for (const model of models)
    if (
      model.enabled &&
      !bindings.some((binding) => binding.modelKey === model.key && binding.enabled)
    )
      throw new Error("MODEL_ENABLED_WITHOUT_BINDING");
  const productRoutes = sortUnique(
    input.productRoutes,
    routePositionKey,
    "MODEL_PRODUCT_ROUTE_POSITION_DUPLICATE",
  ).map((item) =>
    Object.freeze({
      ...item,
      product: product(item.product),
      role: role(item.role),
      modelKey: member(item.modelKey, modelKeys, "MODEL_ROUTE_MODEL_UNKNOWN"),
      position: boundedPosition(item.position),
      requiredCapabilities: sortedStrings(item.requiredCapabilities),
    }),
  );
  assertNoDuplicate(
    productRoutes,
    (item) => `${item.product}:${item.role}:${item.modelKey}`,
    "MODEL_PRODUCT_ROUTE_MODEL_DUPLICATE",
  );
  for (const item of productRoutes) {
    const model = models.find((candidate) => candidate.key === item.modelKey)!;
    if (!bindings.some((binding) => binding.modelKey === item.modelKey))
      throw new Error("MODEL_ROUTE_WITHOUT_BINDING");
    if (!item.requiredCapabilities.every((capability) => model.capabilities.includes(capability)))
      throw new Error("MODEL_ROUTE_CAPABILITY_IMPOSSIBLE");
  }
  for (const name of modelProducts) {
    if (
      !productRoutes.some(
        (item) =>
          item.product === name &&
          item.role === "main" &&
          item.position === 0 &&
          item.requiredCapabilities.includes("chat"),
      )
    )
      throw new Error(`MODEL_PRODUCT_MAIN_REQUIRED:${name}`);
    if (
      name !== "chat" &&
      !productRoutes.some(
        (item) =>
          item.product === name &&
          item.role === "generation" &&
          item.position === 0 &&
          item.requiredCapabilities.includes(`${name}.generate`),
      )
    )
      throw new Error(`MODEL_PRODUCT_GENERATION_REQUIRED:${name}`);
  }
  const sourceKind = input.source.kind;
  if (sourceKind !== "legacy-kokoro-model" && sourceKind !== "platform-native")
    throw new Error("MODEL_INVENTORY_SOURCE_INVALID");
  const document = deepFreeze({
    schemaVersion: 1 as const,
    source: { kind: sourceKind, reference: text(input.source.reference) },
    providers,
    models,
    bindings,
    productRoutes,
  });
  const canonicalJson = stableJson(document);
  return Object.freeze({
    document,
    canonicalJson,
    digest: createHash("sha256").update(canonicalJson).digest("hex"),
    counts: Object.freeze({
      providers: providers.length,
      models: models.length,
      bindings: bindings.length,
      productRoutes: productRoutes.length,
    }),
  });
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
    .join(",")}}`;
}
function sortUnique<T>(items: readonly T[], key: (item: T) => string, code: string): T[] {
  const result = [...items].sort((a, b) => key(a).localeCompare(key(b)));
  if (result.some((item, index) => index > 0 && key(result[index - 1]!) === key(item)))
    throw new Error(code);
  return result;
}
function routePositionKey(item: CanonicalProductRoute): string {
  return `${item.product}:${item.role}:${String(item.position).padStart(6, "0")}`;
}
function identifier(value: string): string {
  if (!/^[a-z0-9][a-z0-9._:-]{0,127}$/u.test(value)) throw new Error("MODEL_IDENTIFIER_INVALID");
  return value;
}
function text(value: string): string {
  if (value.length < 1 || value.length > 512) throw new Error("MODEL_TEXT_INVALID");
  return value;
}
function secretReference(value: string): string {
  if (!/^(?:secret|vault|env):\/\/[A-Za-z0-9._:/-]+$/u.test(value))
    throw new Error("MODEL_SECRET_REFERENCE_INVALID");
  return value;
}
function gatewayName(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,255}$/u.test(value))
    throw new Error("MODEL_GATEWAY_NAME_INVALID");
  return value;
}
function boundedPosition(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 10_000)
    throw new Error("MODEL_POSITION_INVALID");
  return value;
}
function positiveInteger(value: number, code: string): number {
  if (!Number.isInteger(value) || value < 1) throw new Error(code);
  return value;
}
function sortedStrings(values: readonly string[]): readonly string[] {
  const result = [...new Set(values.map(identifier))].sort();
  if (result.length !== values.length) throw new Error("MODEL_LIST_DUPLICATE");
  return Object.freeze(result);
}
function member(value: string, values: ReadonlySet<string>, code: string): string {
  const parsed = identifier(value);
  if (!values.has(parsed)) throw new Error(code);
  return parsed;
}
function product(value: string): ModelProduct {
  if (!(modelProducts as readonly string[]).includes(value))
    throw new Error("MODEL_PRODUCT_INVALID");
  return value as ModelProduct;
}
function role(value: string): ModelRouteRole {
  if (value !== "main" && value !== "generation") throw new Error("MODEL_ROUTE_ROLE_INVALID");
  return value;
}
function adapterKind(value: string): ProviderAdapterKind {
  if (value !== "litellm" && value !== "direct") throw new Error("MODEL_ADAPTER_KIND_INVALID");
  return value;
}
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.values(value as Record<string, unknown>).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}
function assertNoDuplicate<T>(items: readonly T[], key: (item: T) => string, code: string): void {
  const seen = new Set<string>();
  for (const item of items) {
    const value = key(item);
    if (seen.has(value)) throw new Error(code);
    seen.add(value);
  }
}
