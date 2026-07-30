import { describe, expect, it } from "vitest";
import { UsageSettlementService } from
  "../../src/modules/credit/application/usage-settlement-service.js";
import { createUsageSettlementProductionComposition } from
  "../../src/process/usage-settlement-composition.js";

describe("Usage settlement production composition", () => {
  it("exposes one owner shared by every usage producer", () => {
    const composition = createUsageSettlementProductionComposition({ repository: {} as never });
    expect(composition.owner).toBeInstanceOf(UsageSettlementService);
  });
});
