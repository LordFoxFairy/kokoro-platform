import { describe, expect, it } from "vitest";
import { canonicalizeModelInventory } from "../../src/modules/model-control/domain/model-catalog.js";

describe("ModelControl legacy migration bundle", () => {
  it("preserves provider operational facts and emits every Site deterministically", async () => {
    const { createModelControlMigrationBundle, verifyModelControlMigrationBundle } =
      await import("../../src/modules/model-control/migration/model-control-migration-bundle.js");
    const input = {
      catalog: catalog(),
      providerAvailability: [
        {
          providerKey: "provider-a",
          status: "disabled" as const,
          health: "down" as const,
          epoch: "0",
          observationRef: "legacy:model_provider_accounts:provider-a",
          observedAt: "2026-07-28T12:00:00.000Z",
        },
      ],
      sites: [
        { siteId: "site-b", hiddenModelKeys: [] },
        { siteId: "site-a", hiddenModelKeys: ["chat-primary"] },
      ],
    };

    const first = createModelControlMigrationBundle(input);
    const second = createModelControlMigrationBundle({
      ...input,
      sites: [...input.sites].reverse(),
    });

    expect(first).toEqual(second);
    expect(first.providerAvailability).toEqual(input.providerAvailability);
    expect(first.sitePolicyCommands).toHaveLength(8);
    expect(new Set(first.sitePolicyCommands.map((command) => command.changeId)).size).toBe(8);
    expect(first.sitePolicyCommands.every((command) => command.expectedRevision === "0")).toBe(
      true,
    );
    expect(
      first.sitePolicyCommands.some(
        (command) => command.policy.siteId === "site-b" && command.policy.product === "video",
      ),
    ).toBe(true);
    expect(first.importId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(first.activationId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(verifyModelControlMigrationBundle(JSON.parse(JSON.stringify(first)))).toEqual(first);
    expect(() =>
      verifyModelControlMigrationBundle({
        ...first,
        providerAvailability: [{ ...first.providerAvailability[0], health: "healthy" }],
      }),
    ).toThrowError("MODEL_MIGRATION_BUNDLE_DIGEST_MISMATCH");
  });
});

function catalog() {
  const productRoutes = [
    ...(["chat", "music", "image", "video"] as const).flatMap((product) => [
      {
        product,
        role: "main" as const,
        modelKey: "chat-primary",
        position: 0,
        requiredCapabilities: ["chat"],
      },
      {
        product,
        role: "main" as const,
        modelKey: "chat-fallback",
        position: 1,
        requiredCapabilities: ["chat"],
      },
    ]),
    ...(["music", "image", "video"] as const).map((product) => ({
      product,
      role: "generation" as const,
      modelKey: `${product}-gen`,
      position: 0,
      requiredCapabilities: [`${product}.generate`],
    })),
  ];
  const models = [
    ...["chat-primary", "chat-fallback"].map((key) => ({
      key,
      displayName: key,
      inputModalities: ["text"],
      outputModalities: ["text"],
      capabilities: ["chat"],
      contextWindow: 1,
      enabled: true,
    })),
    ...(["music", "image", "video"] as const).map((product) => ({
      key: `${product}-gen`,
      displayName: `${product}-gen`,
      inputModalities: ["text"],
      outputModalities: [product === "music" ? "audio" : product],
      capabilities: [`${product}.generate`],
      contextWindow: null,
      enabled: true,
    })),
  ];
  const bindings = models.map((model, priority) => ({
    key: `binding:${model.key}`,
    modelKey: model.key,
    providerKey: "provider-a",
    upstreamModel: model.key,
    gatewayModelName: model.key,
    priority,
    enabled: true,
  }));
  return canonicalizeModelInventory({
    schemaVersion: 1 as const,
    source: { kind: "legacy-kokoro-model" as const, reference: "legacy-1" },
    providers: [
      {
        key: "provider-a",
        provider: "openai-compatible",
        accountKey: "primary",
        secretRef: "secret://provider-a",
        adapterKind: "litellm" as const,
        priority: 0,
      },
    ],
    models,
    bindings,
    productRoutes,
  });
}
