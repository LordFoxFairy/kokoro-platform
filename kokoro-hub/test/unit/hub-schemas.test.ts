import { describe, expect, it } from "vitest";
import {
  enableBodySchema,
  nameParamsSchema,
  namespaceQuerySchema,
  officialFlagsBodySchema,
  scopeNameParamsSchema,
} from "../../src/interfaces/http/schemas.js";

describe("hub request schemas", () => {
  it("requires a non-empty namespace and rejects unknown query keys", () => {
    expect(namespaceQuerySchema.parse({ namespace: "ns-1" })).toEqual({ namespace: "ns-1" });
    expect(namespaceQuerySchema.safeParse({ namespace: "" }).success).toBe(false);
    expect(namespaceQuerySchema.safeParse({}).success).toBe(false);
    expect(namespaceQuerySchema.safeParse({ namespace: "ns", extra: "x" }).success).toBe(false);
  });

  it("parses scope/name and name params", () => {
    expect(scopeNameParamsSchema.parse({ scope: "official", name: "writer" })).toEqual({
      scope: "official",
      name: "writer",
    });
    expect(nameParamsSchema.parse({ name: "writer" })).toEqual({ name: "writer" });
    expect(scopeNameParamsSchema.safeParse({ scope: "official" }).success).toBe(false);
  });

  it("requires namespace in enable body", () => {
    expect(enableBodySchema.parse({ namespace: "ns-1" })).toEqual({ namespace: "ns-1" });
    expect(enableBodySchema.safeParse({}).success).toBe(false);
  });

  it("accepts partial official flags but rejects an empty update", () => {
    expect(officialFlagsBodySchema.parse({ enabled: false })).toEqual({ enabled: false });
    expect(officialFlagsBodySchema.parse({ required: true })).toEqual({ required: true });
    expect(officialFlagsBodySchema.parse({ enabled: true, required: false })).toEqual({
      enabled: true,
      required: false,
    });
    expect(officialFlagsBodySchema.safeParse({}).success).toBe(false);
    expect(officialFlagsBodySchema.safeParse({ other: 1 }).success).toBe(false);
  });
});
