import { describe, expect, it } from "vitest";
import {
  ensureModelBindingRequestSchema,
  ensureProviderAccountRequestSchema,
  listModelBindingsQuerySchema,
  modelTransportKindSchema,
  resolveModelBindingsQuerySchema,
  siteModelPolicyStatusSchema,
  upsertSiteModelPolicyRequestSchema,
} from "../../src/interfaces/http/schemas.js";

const validAccount = {
  provider: "openai",
  key: "main",
  label: "OpenAI Main",
  secretRef: "secret://openai/main",
  transportKind: "litellm" as const,
};

const validBinding = {
  providerAccountId: "pa1",
  modelName: "gpt-4o",
  displayName: "GPT-4o",
  featureKey: "chat",
  transportKind: "direct" as const,
};

describe("model HTTP schemas reject unknown fields (.strict)", () => {
  it("ensureProviderAccountRequestSchema rejects extra keys", () => {
    expect(() => ensureProviderAccountRequestSchema.parse({ ...validAccount, extra: 1 })).toThrow();
  });
  it("ensureModelBindingRequestSchema rejects extra keys", () => {
    expect(() => ensureModelBindingRequestSchema.parse({ ...validBinding, bogus: true })).toThrow();
  });
  it("listModelBindingsQuerySchema rejects extra keys", () => {
    expect(() => listModelBindingsQuerySchema.parse({ featureKey: "chat", junk: "x" })).toThrow();
  });
});

describe("ensureProviderAccountRequestSchema boundaries", () => {
  it.each(["provider", "key", "label", "secretRef"])("rejects empty %s", (field) => {
    expect(() => ensureProviderAccountRequestSchema.parse({ ...validAccount, [field]: "" })).toThrow();
  });
  it.each(["provider", "key", "label", "secretRef", "transportKind"])("rejects missing %s", (field) => {
    const payload: Record<string, unknown> = { ...validAccount };
    delete payload[field];
    expect(() => ensureProviderAccountRequestSchema.parse(payload)).toThrow();
  });
  it.each(["", "http", "openai", "LITELLM"])("rejects invalid transportKind %j", (transportKind) => {
    expect(() => ensureProviderAccountRequestSchema.parse({ ...validAccount, transportKind })).toThrow();
  });
  it.each([-1, 1.5, Number.NaN])("rejects invalid priority %j", (priority) => {
    expect(() => ensureProviderAccountRequestSchema.parse({ ...validAccount, priority })).toThrow();
  });
  it("accepts omitted optional priority", () => {
    expect(ensureProviderAccountRequestSchema.parse(validAccount).priority).toBeUndefined();
  });
  it.each(["litellm", "direct", "internal"])("accepts transportKind %j", (transportKind) => {
    expect(ensureProviderAccountRequestSchema.parse({ ...validAccount, transportKind }).transportKind).toBe(
      transportKind,
    );
  });
});

describe("ensureModelBindingRequestSchema boundaries", () => {
  it.each(["providerAccountId", "modelName", "displayName", "featureKey"])("rejects empty %s", (field) => {
    expect(() => ensureModelBindingRequestSchema.parse({ ...validBinding, [field]: "" })).toThrow();
  });
  it.each(["providerAccountId", "modelName", "displayName", "featureKey", "transportKind"])(
    "rejects missing %s",
    (field) => {
      const payload: Record<string, unknown> = { ...validBinding };
      delete payload[field];
      expect(() => ensureModelBindingRequestSchema.parse(payload)).toThrow();
    },
  );
  it("rejects invalid transportKind", () => {
    expect(() => ensureModelBindingRequestSchema.parse({ ...validBinding, transportKind: "grpc" })).toThrow();
  });
  it("rejects non-string entry in labelKeys", () => {
    expect(() => ensureModelBindingRequestSchema.parse({ ...validBinding, labelKeys: [1] })).toThrow();
  });
  it("rejects empty string entry in inputModalities", () => {
    expect(() => ensureModelBindingRequestSchema.parse({ ...validBinding, inputModalities: [""] })).toThrow();
  });
  it.each([0, -1, 1.5])("rejects non-positive-int contextWindow %j", (contextWindow) => {
    expect(() => ensureModelBindingRequestSchema.parse({ ...validBinding, contextWindow })).toThrow();
  });
  it("rejects empty gatewayModelName", () => {
    expect(() => ensureModelBindingRequestSchema.parse({ ...validBinding, gatewayModelName: "" })).toThrow();
  });
  it("defaults array fields to empty when omitted", () => {
    const parsed = ensureModelBindingRequestSchema.parse(validBinding);
    expect(parsed.labelKeys).toEqual([]);
    expect(parsed.inputModalities).toEqual([]);
    expect(parsed.outputModalities).toEqual([]);
  });
  it("accepts a fully populated binding", () => {
    const parsed = ensureModelBindingRequestSchema.parse({
      ...validBinding,
      labelKeys: ["chat.default"],
      inputModalities: ["text"],
      outputModalities: ["text"],
      gatewayModelName: "openai/gpt-4o",
      contextWindow: 128000,
      priority: 10,
    });
    expect(parsed.gatewayModelName).toBe("openai/gpt-4o");
    expect(parsed.contextWindow).toBe(128000);
  });
});

describe("listModelBindingsQuerySchema boundaries", () => {
  it("accepts an empty query", () => {
    expect(listModelBindingsQuerySchema.parse({})).toEqual({});
  });
  it.each(["featureKey", "labelKey"])("rejects empty %s", (field) => {
    expect(() => listModelBindingsQuerySchema.parse({ [field]: "" })).toThrow();
  });
});

describe("resolveModelBindingsQuerySchema boundaries", () => {
  it("rejects missing featureKey", () => {
    expect(() => resolveModelBindingsQuerySchema.parse({})).toThrow();
  });
  it("rejects empty featureKey", () => {
    expect(() => resolveModelBindingsQuerySchema.parse({ featureKey: "" })).toThrow();
  });
  it("rejects unknown fields", () => {
    expect(() => resolveModelBindingsQuerySchema.parse({ featureKey: "chat", junk: "x" })).toThrow();
  });
  it("rejects invalid transportKind", () => {
    expect(() => resolveModelBindingsQuerySchema.parse({ featureKey: "chat", transportKind: "grpc" })).toThrow();
  });
  it("accepts featureKey only", () => {
    expect(resolveModelBindingsQuerySchema.parse({ featureKey: "chat" })).toEqual({ featureKey: "chat" });
  });
  it("accepts featureKey + labelKey + transportKind", () => {
    expect(
      resolveModelBindingsQuerySchema.parse({ featureKey: "chat", labelKey: "chat.default", transportKind: "direct" }),
    ).toEqual({ featureKey: "chat", labelKey: "chat.default", transportKind: "direct" });
  });
});

describe("upsertSiteModelPolicyRequestSchema boundaries", () => {
  const valid = { siteId: "site-a", labelKey: "chat.premium", status: "hidden" as const };

  it("accepts a valid payload", () => {
    expect(upsertSiteModelPolicyRequestSchema.parse(valid)).toEqual(valid);
  });
  it("rejects unknown fields", () => {
    expect(() => upsertSiteModelPolicyRequestSchema.parse({ ...valid, junk: 1 })).toThrow();
  });
  it.each(["siteId", "labelKey"])("rejects empty %s", (field) => {
    expect(() => upsertSiteModelPolicyRequestSchema.parse({ ...valid, [field]: "" })).toThrow();
  });
  it.each(["siteId", "labelKey", "status"])("rejects missing %s", (field) => {
    const payload: Record<string, unknown> = { ...valid };
    delete payload[field];
    expect(() => upsertSiteModelPolicyRequestSchema.parse(payload)).toThrow();
  });
  it.each(["", "shown", "VISIBLE", "deleted"])("rejects invalid status %j", (status) => {
    expect(() => upsertSiteModelPolicyRequestSchema.parse({ ...valid, status })).toThrow();
  });
});

describe("siteModelPolicyStatusSchema", () => {
  it.each(["visible", "hidden"])("accepts %j", (status) => {
    expect(siteModelPolicyStatusSchema.parse(status)).toBe(status);
  });
  it.each(["", "shown", "HIDDEN"])("rejects %j", (status) => {
    expect(() => siteModelPolicyStatusSchema.parse(status)).toThrow();
  });
});

describe("modelTransportKindSchema", () => {
  it.each(["litellm", "direct", "internal"])("accepts %j", (kind) => {
    expect(modelTransportKindSchema.parse(kind)).toBe(kind);
  });
  it.each(["", "rest", "DIRECT"])("rejects %j", (kind) => {
    expect(() => modelTransportKindSchema.parse(kind)).toThrow();
  });
});

describe("ensureModelBindingRequestSchema litellm gateway requirement", () => {
  const base = {
    providerAccountId: "p1",
    modelName: "gpt-4o",
    displayName: "GPT-4o",
    featureKey: "chat",
  };

  it("rejects litellm binding without gatewayModelName", () => {
    expect(() =>
      ensureModelBindingRequestSchema.parse({ ...base, transportKind: "litellm" }),
    ).toThrow();
  });

  it("accepts litellm binding with gatewayModelName", () => {
    expect(
      ensureModelBindingRequestSchema.parse({
        ...base,
        transportKind: "litellm",
        gatewayModelName: "openai/gpt-4o",
      }).gatewayModelName,
    ).toBe("openai/gpt-4o");
  });

  it("accepts direct binding without gatewayModelName", () => {
    expect(
      ensureModelBindingRequestSchema.parse({ ...base, transportKind: "direct" }).transportKind,
    ).toBe("direct");
  });
});
