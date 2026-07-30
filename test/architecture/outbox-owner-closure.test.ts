import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  OUTBOX_OWNER_CONSUMER_REGISTRY,
  outboxOwnersForConsumer,
} from "../../src/shared/outbox-inbox/outbox.js";

const expectedClosure = Object.freeze({
  identity: "identity-worker",
  commerce: "commerce-worker",
  credit: "commerce-worker",
  site: "site-worker",
  asset: "asset-worker",
  "admin-execution": "admin-worker",
} as const);

describe("Platform outbox producer to consumer closure", () => {
  it("keeps the complete owner set closed over one real worker authority", () => {
    expect(OUTBOX_OWNER_CONSUMER_REGISTRY).toEqual(expectedClosure);
    expect(outboxOwnersForConsumer("identity-worker")).toEqual(["identity"]);
    expect(outboxOwnersForConsumer("commerce-worker")).toEqual(["commerce", "credit"]);
    expect(outboxOwnersForConsumer("site-worker")).toEqual(["site"]);
    expect(outboxOwnersForConsumer("asset-worker")).toEqual(["asset"]);
    expect(outboxOwnersForConsumer("admin-worker")).toEqual(["admin-execution"]);
  });

  it("enforces the same closed owner set at the PostgreSQL boundary", async () => {
    const migration = await readFile(new URL(
      "../../prisma/migrations/0002_platform_transaction_kernel/migration.sql",
      import.meta.url,
    ), "utf8");
    expect(migration).toContain(
      "owner TEXT NOT NULL CHECK (owner IN ('identity','commerce','credit','site','asset','admin-execution'))",
    );
    for (const orphan of ["admin-control", "model-control", "credit-usage-rating"]) {
      expect(migration).not.toContain(`'${orphan}'`);
    }
  });
});
