import { describe, expect, it } from "vitest";
import { canonicalizeModelInventory } from "../../src/modules/model-control/domain/model-catalog.js";
import {
  compileModelOptionRevision,
  createSiteReleaseModelCatalogRevision,
  projectProductModelOptionCatalogs,
  verifyModelOptionRevision,
} from "../../src/modules/model-control/domain/product-model-option.js";
import { materializeModelOptionDraftSet } from "../../src/modules/model-control/domain/model-option-materialization.js";

describe("Product ModelOption and SiteRelease catalog", () => {
  it("composes one inventory into complete Chat and Music options without leaking internal routes", () => {
    const inventory = catalog();
    const chat = compileModelOptionRevision({
      inventory,
      draft: option("chat.standard", "chat", ["chat-primary", "chat-fallback"], "chat-primary"),
    });
    const music = compileModelOptionRevision({
      inventory,
      draft: option("music.quality", "music", ["music-gen", "music-fallback"], "music-gen"),
    });

    expect(chat.composition.orchestration.roleKey).toBe("assistant.primary");
    expect(chat.composition.generation).toEqual(chat.composition.orchestration);
    expect(music.composition).toMatchObject({
      orchestration: {
        roleKey: "music.assistant",
        primaryModelKey: "chat-primary",
        fallbackModelKeys: ["chat-fallback"],
        fallbackPolicy: "ordered_pre_effect_only",
      },
      generation: {
        roleKey: "music.generation",
        primaryModelKey: "music-gen",
        fallbackModelKeys: ["music-fallback"],
        fallbackPolicy: "ordered_pre_effect_only",
      },
    });
    expect(music.inventoryDigest).toBe(inventory.digest);

    const release = createSiteReleaseModelCatalogRevision({
      siteId: "site-a",
      siteReleaseRef: "release-a",
      inventoryDigest: inventory.digest,
      publishedAt: "2026-07-29T12:00:00.000Z",
      surfaces: [
        {
          surfaceId: "chat",
          allowedModelOptionRevisionRefs: [chat.modelOptionRevisionRef],
          defaultModelOptionRevisionRef: chat.modelOptionRevisionRef,
        },
        {
          surfaceId: "music",
          allowedModelOptionRevisionRefs: [music.modelOptionRevisionRef],
          defaultModelOptionRevisionRef: music.modelOptionRevisionRef,
        },
      ],
      optionRevisions: [music, chat],
    });
    const projected = projectProductModelOptionCatalogs({
      release,
      optionRevisions: [chat, music],
      runtimeAvailableModelKeys: ["chat-primary", "music-gen"],
    });

    expect(projected.modelOptionCatalogs).toHaveLength(2);
    expect(projected.modelOptionCatalogs[1]).toMatchObject({
      surfaceId: "music",
      defaultModelOptionRevisionRef: music.modelOptionRevisionRef,
      options: [{ optionKey: "music.quality", availability: "available" }],
    });
    const wire = JSON.stringify(projected);
    expect(wire).not.toMatch(/provider|secret|route|fallback|orchestration|primaryModelKey/u);
  });

  it("fails compilation when a professional surface lacks its required orchestration role", () => {
    const inventory = catalog();
    const withoutMusicMain = canonicalizeModelInventory({
      ...inventory.document,
      models: inventory.document.models.map((entry) =>
        entry.capabilities.includes("chat") ? { ...entry, enabled: false } : entry,
      ),
      bindings: inventory.document.bindings.map((entry) =>
        entry.modelKey.startsWith("chat-") ? { ...entry, enabled: false } : entry,
      ),
    });
    expect(() =>
      compileModelOptionRevision({
        inventory: withoutMusicMain,
        draft: option("music.quality", "music", ["music-gen"], "music-gen"),
      }),
    ).toThrowError("MODEL_OPTION_ORCHESTRATION_ROLE_REQUIRED");
  });

  it("publishes only the public contract safely supported by every generation fallback", () => {
    const base = catalog();
    const inventory = canonicalizeModelInventory({
      ...base.document,
      models: [
        ...base.document.models,
        model("music-incompatible", ["image"], ["image"], ["music.generate"]),
      ],
      bindings: [
        ...base.document.bindings,
        {
          key: "binding:music-incompatible",
          modelKey: "music-incompatible",
          providerKey: "provider-a",
          upstreamModel: "music-incompatible",
          gatewayModelName: "music-incompatible",
          priority: 99,
          enabled: true,
        },
      ],
      productRoutes: [
        ...base.document.productRoutes,
        route("music", "generation", "music-incompatible", 2, ["music.generate"]),
      ],
    });

    expect(() =>
      compileModelOptionRevision({
        inventory,
        draft: option(
          "music.unsafe-fallback",
          "music",
          ["music-gen", "music-incompatible"],
          "music-gen",
        ),
      }),
    ).toThrowError("MODEL_OPTION_PUBLIC_CONTRACT_INCOMPATIBLE");
  });

  it("verifies surface-specific roles and Chat's single assistant composition", () => {
    const inventory = catalog();
    const chat = compileModelOptionRevision({
      inventory,
      draft: option("chat.standard", "chat", ["chat-primary", "chat-fallback"], "chat-primary"),
    });
    const wrongChatComposition = JSON.parse(JSON.stringify(chat)) as Record<string, unknown>;
    const composition = wrongChatComposition.composition as Record<string, unknown>;
    composition.generation = {
      ...(composition.generation as Record<string, unknown>),
      primaryModelKey: "chat-fallback",
      fallbackModelKeys: ["chat-primary"],
    };
    expect(() => verifyModelOptionRevision(wrongChatComposition)).toThrowError(
      "MODEL_OPTION_CHAT_COMPOSITION_INVALID",
    );

    const music = compileModelOptionRevision({
      inventory,
      draft: option("music.quality", "music", ["music-gen"], "music-gen"),
    });
    const wrongMusicRole = JSON.parse(JSON.stringify(music)) as Record<string, unknown>;
    const musicComposition = wrongMusicRole.composition as Record<string, unknown>;
    musicComposition.generation = {
      ...(musicComposition.generation as Record<string, unknown>),
      roleKey: "image.generation",
    };
    expect(() => verifyModelOptionRevision(wrongMusicRole)).toThrowError(
      "MODEL_OPTION_ROLE_SURFACE_MISMATCH",
    );
  });

  it("rejects a default outside the published, same-surface, structurally usable option set", () => {
    const inventory = catalog();
    const chat = compileModelOptionRevision({
      inventory,
      draft: option("chat.standard", "chat", ["chat-primary"], "chat-primary"),
    });
    const music = compileModelOptionRevision({
      inventory,
      draft: option("music.quality", "music", ["music-gen"], "music-gen"),
    });
    expect(() =>
      createSiteReleaseModelCatalogRevision({
        siteId: "site-a",
        siteReleaseRef: "release-a",
        inventoryDigest: inventory.digest,
        publishedAt: "2026-07-29T12:00:00.000Z",
        surfaces: [
          {
            surfaceId: "chat",
            allowedModelOptionRevisionRefs: [chat.modelOptionRevisionRef],
            defaultModelOptionRevisionRef: music.modelOptionRevisionRef,
          },
        ],
        optionRevisions: [chat, music],
      }),
    ).toThrowError("MODEL_OPTION_DEFAULT_NOT_PUBLISHED");
    expect(() =>
      createSiteReleaseModelCatalogRevision({
        siteId: "site-a",
        siteReleaseRef: "release-a",
        inventoryDigest: inventory.digest,
        publishedAt: "2026-07-29T12:00:00.000Z",
        surfaces: [
          {
            surfaceId: "chat",
            allowedModelOptionRevisionRefs: [music.modelOptionRevisionRef],
            defaultModelOptionRevisionRef: music.modelOptionRevisionRef,
          },
        ],
        optionRevisions: [music],
      }),
    ).toThrowError("MODEL_OPTION_SURFACE_MISMATCH");
  });

  it("fails ProductContext when the exact published default has no runtime-available route", () => {
    const inventory = catalog();
    const primary = compileModelOptionRevision({
      inventory,
      draft: option("music.primary", "music", ["music-gen"], "music-gen"),
    });
    const alternative = compileModelOptionRevision({
      inventory,
      draft: option("music.alternative", "music", ["music-fallback"], "music-fallback"),
    });
    const release = createSiteReleaseModelCatalogRevision({
      siteId: "site-a",
      siteReleaseRef: "release-a",
      inventoryDigest: inventory.digest,
      publishedAt: "2026-07-29T12:00:00.000Z",
      surfaces: [
        {
          surfaceId: "music",
          allowedModelOptionRevisionRefs: [primary.modelOptionRevisionRef, alternative.modelOptionRevisionRef],
          defaultModelOptionRevisionRef: primary.modelOptionRevisionRef,
        },
      ],
      optionRevisions: [primary, alternative],
    });
    expect(() =>
      projectProductModelOptionCatalogs({
        release,
        optionRevisions: [primary, alternative],
        runtimeAvailableModelKeys: ["chat-primary", "music-fallback"],
      }),
    ).toThrowError("MODEL_OPTION_DEFAULT_UNAVAILABLE");
  });

  it("materializes a canonical native draft set independent of input order", () => {
    const inventory = catalog();
    const first = materializeModelOptionDraftSet({
      inventory,
      draftSet: {
        schemaVersion: 1,
        inventoryDigest: inventory.digest,
        options: [
          option("music.quality", "music", ["music-gen", "music-fallback"], "music-gen"),
          option("chat.standard", "chat", ["chat-primary", "chat-fallback"], "chat-primary"),
        ],
      },
    });
    const second = materializeModelOptionDraftSet({
      inventory,
      draftSet: {
        schemaVersion: 1,
        inventoryDigest: inventory.digest,
        options: [...first.optionRevisions].reverse().map((revision) =>
          option(
            revision.optionKey,
            revision.surface,
            [revision.composition.generation.primaryModelKey,
              ...revision.composition.generation.fallbackModelKeys],
            revision.composition.generation.primaryModelKey,
          )),
      },
    });
    expect(first.compilerVersion).toBe("model-option-compiler.v2");
    expect(first.optionRevisions.map(({ optionKey }) => optionKey)).toEqual([
      "chat.standard", "music.quality",
    ]);
    expect(second.materializationDigest).toBe(first.materializationDigest);
  });
});

function option(
  key: string,
  product: "chat" | "music" | "image" | "video",
  candidates: string[],
  defaultModelKey: string,
) {
  const generation = {
    primaryModelKey: defaultModelKey,
    fallbackModelKeys: candidates.filter((candidate) => candidate !== defaultModelKey),
  };
  return {
    schemaVersion: 1 as const,
    optionKey: key,
    surface: product,
    label: key,
    description: `${key} description`,
    tier: "standard",
    lifecycle: "active" as const,
    composition: {
      orchestration: product === "chat"
        ? generation
        : { primaryModelKey: "chat-primary", fallbackModelKeys: ["chat-fallback"] },
      generation,
    },
  } as const;
}

function catalog() {
  const models = [
    model("chat-primary", ["text"], ["text"], ["chat"]),
    model("chat-fallback", ["text"], ["text"], ["chat"]),
    model("music-gen", ["text"], ["audio"], ["music.generate"]),
    model("music-fallback", ["text"], ["audio"], ["music.generate"]),
    model("image-gen", ["text"], ["image"], ["image.generate"]),
    model("video-gen", ["text", "image"], ["video"], ["video.generate"]),
  ];
  return canonicalizeModelInventory({
    schemaVersion: 1,
    source: { kind: "platform-native", reference: "product-model-option-test" },
    providers: [
      {
        key: "provider-a",
        provider: "openai-compatible",
        accountKey: "primary",
        secretRef: "secret://provider-a",
        adapterKind: "litellm",
        priority: 0,
      },
    ],
    models,
    bindings: models.map((entry, priority) => ({
      key: `binding:${entry.key}`,
      modelKey: entry.key,
      providerKey: "provider-a",
      upstreamModel: entry.key,
      gatewayModelName: entry.key,
      priority,
      enabled: true,
    })),
    productRoutes: [
      ...(["chat", "music", "image", "video"] as const).flatMap((product) => [
        route(product, "main", "chat-primary", 0, ["chat"]),
        route(product, "main", "chat-fallback", 1, ["chat"]),
      ]),
      route("music", "generation", "music-gen", 0, ["music.generate"]),
      route("music", "generation", "music-fallback", 1, ["music.generate"]),
      route("image", "generation", "image-gen", 0, ["image.generate"]),
      route("video", "generation", "video-gen", 0, ["video.generate"]),
    ],
  });
}

function model(
  key: string,
  inputModalities: string[],
  outputModalities: string[],
  capabilities: string[],
) {
  return {
    key,
    displayName: key,
    inputModalities,
    outputModalities,
    capabilities,
    contextWindow: null,
    enabled: true,
  };
}

function route(
  product: "chat" | "music" | "image" | "video",
  role: "main" | "generation",
  modelKey: string,
  position: number,
  requiredCapabilities: string[],
) {
  return { product, role, modelKey, position, requiredCapabilities };
}
