import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createLegacyModelOptionMigrationArtifact,
  verifyLegacyModelOptionMigrationArtifact,
} from "../../src/modules/model-control/migration/legacy-model-option-artifact.js";

describe("legacy ModelLabel migration artifact", () => {
  it("preserves public option facts outside the base model inventory", () => {
    const artifact = createLegacyModelOptionMigrationArtifact({
      labels: [
        {
          legacyLabelId: "label-fast",
          key: "chat.fast",
          displayName: "Fast",
          description: "Low latency",
          featureKey: "chat",
          tier: "standard",
          defaultBindingId: "legacy-binding-fast",
          status: "active",
        },
      ],
      bindings: [
        {
          legacyBindingId: "legacy-binding-safe",
          modelKey: "model-safe",
          labelKeys: ["chat.fast"],
          priority: 20,
        },
        {
          legacyBindingId: "legacy-binding-fast",
          modelKey: "model-fast",
          labelKeys: ["chat.fast"],
          priority: 10,
        },
      ],
      referencedLabelKeys: ["chat.fast"],
    });
    expect(artifact.options).toEqual([
      {
        legacyLabelId: "label-fast",
        key: "chat.fast",
        product: "chat",
        displayName: "Fast",
        description: "Low latency",
        tier: "standard",
        defaultModelKey: "model-fast",
        candidateModelKeys: ["model-fast", "model-safe"],
        enabled: true,
      },
    ]);
    expect(artifact.quarantine).toEqual([]);
    expect(artifact.artifactDigest).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("quarantines unresolved and orphan labels without reflecting unsafe keys", () => {
    const artifact = createLegacyModelOptionMigrationArtifact({
      labels: [
        {
          legacyLabelId: "label-bad",
          key: "secret\nlabel",
          displayName: "Bad",
          description: null,
          featureKey: "chat",
          tier: null,
          defaultBindingId: "missing-binding",
          status: "active",
        },
      ],
      bindings: [
        {
          legacyBindingId: "legacy-binding-a",
          modelKey: "model-a",
          labelKeys: ["orphan.label"],
          priority: 0,
        },
      ],
      referencedLabelKeys: ["policy.orphan"],
    });
    expect(artifact.options).toEqual([]);
    expect(artifact.quarantine.map(({ reasonCode }) => reasonCode).sort()).toEqual([
      "INVALID_LABEL_FACT",
      "ORPHAN_BINDING_LABEL",
      "ORPHAN_POLICY_LABEL",
    ]);
    expect(JSON.stringify(artifact)).not.toContain("secret\nlabel");
    expect(artifact.sourceCounts).toEqual({
      labels: 1,
      orphanBindingLabels: 1,
      orphanPolicyLabels: 1,
    });
  });

  it("is deterministic across source row ordering", () => {
    const input = {
      labels: [
        {
          legacyLabelId: "label-a",
          key: "music.fast",
          displayName: "Fast music",
          description: null,
          featureKey: "music",
          tier: null,
          defaultBindingId: null,
          status: "disabled" as const,
        },
      ],
      bindings: [
        {
          legacyBindingId: "legacy-music-b",
          modelKey: "music-b",
          labelKeys: ["music.fast"],
          priority: 2,
        },
        {
          legacyBindingId: "legacy-music-a",
          modelKey: "music-a",
          labelKeys: ["music.fast"],
          priority: 1,
        },
      ],
      referencedLabelKeys: ["music.fast"],
    };
    expect(createLegacyModelOptionMigrationArtifact(input).artifactDigest).toBe(
      createLegacyModelOptionMigrationArtifact({
        ...input,
        bindings: [...input.bindings].reverse(),
      }).artifactDigest,
    );
  });

  it("recursively rejects unknown or inconsistent nested artifact facts", () => {
    const artifact = createLegacyModelOptionMigrationArtifact({
      labels: [
        {
          legacyLabelId: "label-a",
          key: "chat.fast",
          displayName: "Fast",
          description: null,
          featureKey: "chat",
          tier: null,
          defaultBindingId: null,
          status: "active",
        },
      ],
      bindings: [
        {
          legacyBindingId: "binding-a",
          modelKey: "model-a",
          labelKeys: ["chat.fast"],
          priority: 0,
        },
      ],
      referencedLabelKeys: [],
    });
    expect(() =>
      verifyLegacyModelOptionMigrationArtifact({
        ...artifact,
        options: [{ ...artifact.options[0], rawSecret: "plaintext" }],
      }),
    ).toThrowError("MODEL_OPTION_MIGRATION_ARTIFACT_INVALID");
    expect(() =>
      verifyLegacyModelOptionMigrationArtifact({
        ...artifact,
        sourceCounts: { ...artifact.sourceCounts, labels: 2 },
      }),
    ).toThrowError("MODEL_OPTION_MIGRATION_ARTIFACT_INVALID");
  });

  it("rejects a recomputed artifact that mismatches quarantine source and reason", () => {
    const artifact = createLegacyModelOptionMigrationArtifact({
      labels: [],
      bindings: [
        {
          legacyBindingId: "binding-a",
          modelKey: "model-a",
          labelKeys: ["orphan.label"],
          priority: 0,
        },
      ],
      referencedLabelKeys: [],
    });
    const payload = {
      schemaVersion: 1 as const,
      sourceCounts: artifact.sourceCounts,
      options: artifact.options,
      quarantine: [{ ...artifact.quarantine[0], sourceKind: "policy" as const }],
    };
    const forged = {
      ...payload,
      artifactDigest: createHash("sha256").update(stableJson(payload)).digest("hex"),
    };
    expect(() => verifyLegacyModelOptionMigrationArtifact(forged)).toThrowError(
      "MODEL_OPTION_MIGRATION_ARTIFACT_INVALID",
    );
  });
});

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
    .join(",")}}`;
}
