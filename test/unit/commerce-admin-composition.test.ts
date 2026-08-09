import { describe, expect, it } from "vitest";
import { createCommerceAdministrationComposition } from
  "../../src/process/commerce-admin-composition.js";

describe("production Commerce administration composition", () => {
  it.each([{}, { PLATFORM_COMMERCE_REDEMPTION_KEY_RING_FILE: "" }])(
    "fails closed before constructing a provider when its redemption key ring is absent",
    async (environment) => {
      await expect(createCommerceAdministrationComposition({
        database: {} as never,
        environment,
      })).rejects.toThrowError("PLATFORM_COMMERCE_REDEMPTION_KEY_RING_FILE_REQUIRED");
    },
  );
});
