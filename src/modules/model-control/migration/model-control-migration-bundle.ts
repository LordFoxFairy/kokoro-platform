import { createHash } from "node:crypto";
import {
  canonicalizeModelInventory,
  modelProducts,
  type CanonicalModelInventory,
  type CanonicalizedModelInventory,
} from "../domain/model-catalog.js";
import {
  canonicalizeProviderOperationalAvailability,
  type ProviderOperationalAvailability,
} from "../domain/provider-availability.js";
import { canonicalizeSiteModelPolicy, type SiteModelPolicy } from "../domain/site-model-policy.js";

export interface ModelControlMigrationBundle {
  readonly schemaVersion: 1;
  readonly bundleDigest: string;
  readonly importId: string;
  readonly activationId: string;
  readonly expectedPointerRevision: "0";
  readonly catalogDigest: string;
  readonly catalog: CanonicalizedModelInventory["document"];
  readonly providerAvailability: readonly ProviderOperationalAvailability[];
  readonly sitePolicyCommands: readonly {
    readonly changeId: string;
    readonly expectedRevision: "0";
    readonly policyDigest: string;
    readonly policy: SiteModelPolicy;
  }[];
}

export function createModelControlMigrationBundle(input: {
  readonly catalog: CanonicalizedModelInventory;
  readonly providerAvailability: readonly ProviderOperationalAvailability[];
  readonly sites: readonly {
    readonly siteId: string;
    readonly hiddenModelKeys: readonly string[];
  }[];
}): ModelControlMigrationBundle {
  const providerAvailability = canonicalizeProviderOperationalAvailability(
    input.providerAvailability,
    new Set(input.catalog.document.providers.map((provider) => provider.key)),
  );
  const sites = uniqueSortedSites(input.sites);
  const sitePolicyCommands = sites.flatMap(({ siteId, hiddenModelKeys }) =>
    modelProducts.map((product) => {
      const assignments = (["main", "generation"] as const).flatMap((role) =>
        input.catalog.document.productRoutes
          .filter(
            (route) =>
              route.product === product &&
              route.role === role &&
              !hiddenModelKeys.includes(route.modelKey),
          )
          .map((route, position) => ({
            role,
            modelKey: route.modelKey,
            position,
            requiredCapabilities: route.requiredCapabilities,
            enabled: true,
          })),
      );
      const enabled =
        assignments.some(
          (assignment) =>
            assignment.role === "main" &&
            assignment.position === 0 &&
            assignment.requiredCapabilities.includes("chat"),
        ) &&
        (product === "chat" ||
          assignments.some(
            (assignment) =>
              assignment.role === "generation" &&
              assignment.position === 0 &&
              assignment.requiredCapabilities.includes(`${product}.generate`),
          ));
      const policy = canonicalizeSiteModelPolicy({
        schemaVersion: 1,
        siteId,
        product,
        enabled,
        catalog: { mode: "pinned", digest: input.catalog.digest },
        assignmentMode: "replace",
        assignments,
      });
      return Object.freeze({
        changeId: deterministicUuid(`site-policy:${siteId}:${product}:${policy.digest}`),
        expectedRevision: "0" as const,
        policyDigest: policy.digest,
        policy: policy.document,
      });
    }),
  );
  const payload = {
    schemaVersion: 1 as const,
    importId: deterministicUuid(`catalog-import:${input.catalog.digest}`),
    activationId: deterministicUuid(`catalog-activation:${input.catalog.digest}`),
    expectedPointerRevision: "0" as const,
    catalogDigest: input.catalog.digest,
    catalog: input.catalog.document,
    providerAvailability,
    sitePolicyCommands,
  };
  return deepFreeze({
    ...payload,
    bundleDigest: sha256(stableJson(payload)),
  });
}

export function verifyModelControlMigrationBundle(input: unknown): ModelControlMigrationBundle {
  const candidate = strictRecord(
    input,
    [
      "schemaVersion",
      "bundleDigest",
      "importId",
      "activationId",
      "expectedPointerRevision",
      "catalogDigest",
      "catalog",
      "providerAvailability",
      "sitePolicyCommands",
    ],
    "MODEL_MIGRATION_BUNDLE_SCHEMA_UNKNOWN_FIELD",
  );
  if (candidate.schemaVersion !== 1) throw new Error("MODEL_MIGRATION_BUNDLE_VERSION_INVALID");
  const catalog = canonicalizeModelInventory(
    strictRecord(
      candidate.catalog,
      ["schemaVersion", "source", "providers", "models", "bindings", "productRoutes"],
      "MODEL_MIGRATION_CATALOG_SCHEMA_UNKNOWN_FIELD",
    ) as unknown as CanonicalModelInventory,
  );
  if (candidate.catalogDigest !== catalog.digest)
    throw new Error("MODEL_MIGRATION_CATALOG_DIGEST_MISMATCH");
  const providerAvailability = canonicalizeProviderOperationalAvailability(
    array(candidate.providerAvailability, "MODEL_MIGRATION_AVAILABILITY_INVALID").map(
      parseProviderAvailability,
    ),
    new Set(catalog.document.providers.map((provider) => provider.key)),
  );
  const sitePolicyCommands = array(
    candidate.sitePolicyCommands,
    "MODEL_MIGRATION_SITE_COMMANDS_INVALID",
  ).map((value) => {
    const command = strictRecord(
      value,
      ["changeId", "expectedRevision", "policyDigest", "policy"],
      "MODEL_MIGRATION_SITE_COMMAND_SCHEMA_UNKNOWN_FIELD",
    );
    const policy = canonicalizeSiteModelPolicy(
      strictRecord(
        command.policy,
        [
          "schemaVersion",
          "siteId",
          "product",
          "enabled",
          "catalog",
          "assignmentMode",
          "assignments",
        ],
        "MODEL_MIGRATION_SITE_POLICY_SCHEMA_UNKNOWN_FIELD",
      ) as unknown as SiteModelPolicy,
    );
    if (
      command.expectedRevision !== "0" ||
      command.policyDigest !== policy.digest ||
      command.changeId !==
        deterministicUuid(
          `site-policy:${policy.document.siteId}:${policy.document.product}:${policy.digest}`,
        )
    )
      throw new Error("MODEL_MIGRATION_SITE_COMMAND_INVALID");
    return Object.freeze({
      changeId: command.changeId,
      expectedRevision: "0" as const,
      policyDigest: policy.digest,
      policy: policy.document,
    });
  });
  assertCommandOrder(sitePolicyCommands);
  const payload = {
    schemaVersion: 1 as const,
    importId: string(candidate.importId, "MODEL_MIGRATION_IMPORT_ID_INVALID"),
    activationId: string(candidate.activationId, "MODEL_MIGRATION_ACTIVATION_ID_INVALID"),
    expectedPointerRevision: candidate.expectedPointerRevision,
    catalogDigest: catalog.digest,
    catalog: catalog.document,
    providerAvailability,
    sitePolicyCommands,
  };
  if (
    payload.importId !== deterministicUuid(`catalog-import:${catalog.digest}`) ||
    payload.activationId !== deterministicUuid(`catalog-activation:${catalog.digest}`) ||
    payload.expectedPointerRevision !== "0"
  )
    throw new Error("MODEL_MIGRATION_GLOBAL_COMMAND_INVALID");
  const bundleDigest = string(candidate.bundleDigest, "MODEL_MIGRATION_BUNDLE_DIGEST_INVALID");
  if (bundleDigest !== sha256(stableJson(payload)))
    throw new Error("MODEL_MIGRATION_BUNDLE_DIGEST_MISMATCH");
  return deepFreeze({ ...payload, expectedPointerRevision: "0", bundleDigest });
}

function parseProviderAvailability(value: unknown): ProviderOperationalAvailability {
  const fact = strictRecord(
    value,
    ["providerKey", "status", "health", "epoch", "observationRef", "observedAt"],
    "MODEL_MIGRATION_AVAILABILITY_SCHEMA_UNKNOWN_FIELD",
  );
  return {
    providerKey: string(fact.providerKey, "MODEL_MIGRATION_AVAILABILITY_INVALID"),
    status: string(fact.status, "MODEL_MIGRATION_AVAILABILITY_INVALID") as "active" | "disabled",
    health: string(
      fact.health,
      "MODEL_MIGRATION_AVAILABILITY_INVALID",
    ) as ProviderOperationalAvailability["health"],
    epoch: string(fact.epoch, "MODEL_MIGRATION_AVAILABILITY_INVALID"),
    observationRef:
      fact.observationRef === null
        ? null
        : string(fact.observationRef, "MODEL_MIGRATION_AVAILABILITY_INVALID"),
    observedAt:
      fact.observedAt === null
        ? null
        : string(fact.observedAt, "MODEL_MIGRATION_AVAILABILITY_INVALID"),
  };
}

function assertCommandOrder(
  commands: readonly ModelControlMigrationBundle["sitePolicyCommands"][number][],
): void {
  const keys = commands.map((command) => `${command.policy.siteId}:${command.policy.product}`);
  const sites = [...new Set(commands.map((command) => command.policy.siteId))].sort((left, right) =>
    left.localeCompare(right),
  );
  const expectedKeys = sites.flatMap((siteId) =>
    modelProducts.map((product) => `${siteId}:${product}`),
  );
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index]))
    throw new Error("MODEL_MIGRATION_SITE_COMMAND_ORDER_INVALID");
  if (commands.length !== sites.length * modelProducts.length)
    throw new Error("MODEL_MIGRATION_SITE_COMMAND_COVERAGE_INVALID");
}

function uniqueSortedSites(
  input: readonly { readonly siteId: string; readonly hiddenModelKeys: readonly string[] }[],
) {
  const sites = [...input]
    .map((site) => ({
      siteId: identifier(site.siteId),
      hiddenModelKeys: [...new Set(site.hiddenModelKeys.map(identifier))].sort(),
    }))
    .sort((left, right) => left.siteId.localeCompare(right.siteId));
  if (sites.some((site, index) => index > 0 && sites[index - 1]!.siteId === site.siteId))
    throw new Error("MODEL_MIGRATION_SITE_DUPLICATE");
  return sites;
}

function deterministicUuid(value: string): string {
  const bytes = Buffer.from(sha256(value).slice(0, 32), "hex");
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function identifier(value: string): string {
  if (!/^[a-z0-9][a-z0-9._:-]{0,127}$/u.test(value)) throw new Error("MODEL_IDENTIFIER_INVALID");
  return value;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
    .join(",")}}`;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function record(value: unknown, code: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(code);
  return value as Record<string, unknown>;
}

function strictRecord(value: unknown, allowed: readonly string[], code: string) {
  const result = record(value, code);
  if (Object.keys(result).some((key) => !allowed.includes(key))) throw new Error(code);
  return result;
}

function array(value: unknown, code: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(code);
  return value;
}

function string(value: unknown, code: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(code);
  return value;
}
