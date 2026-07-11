import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { SkillRequiredError } from "../../src/domain/errors.js";
import { MongoSkillRepository } from "../../src/infrastructure/mongo/mongo-skill-repository.js";
import { connectTestHub, hubTestDbName, insertSkill, type TestHub } from "./helpers.js";

const NS = "ns-alpha";

let hub: TestHub;
let repo: MongoSkillRepository;

async function init(): Promise<void> {
  hub = await connectTestHub(hubTestDbName("repo"));
  repo = new MongoSkillRepository(hub.collections);
}

const ready = init();

describe("MongoSkillRepository (real mongo)", () => {
  beforeEach(async () => {
    await ready;
    await hub.clean();
  });

  afterAll(async () => {
    await hub.dropDatabase();
    await hub.client.close();
  });

  it("lists enabled official skills as pool cards", async () => {
    await insertSkill(hub.collections, { scope: "official", name: "writer" });

    const pool = await repo.listPool(NS);
    expect(pool).toEqual([
      { name: "writer", description: "desc-writer", content_hash: "hash-official-writer", scope: "official" },
    ]);
  });

  it("lets a namespace-owned skill override the official skill of the same name", async () => {
    await insertSkill(hub.collections, { scope: "official", name: "writer" });
    await insertSkill(hub.collections, { scope: NS, name: "writer" });

    const pool = await repo.listPool(NS);
    expect(pool).toHaveLength(1);
    expect(pool[0]).toMatchObject({ name: "writer", scope: NS });
  });

  it("hides an official skill whose official_enabled is false unless required", async () => {
    await insertSkill(hub.collections, { scope: "official", name: "beta", official_enabled: false });
    await insertSkill(hub.collections, {
      scope: "official",
      name: "guard",
      official_enabled: false,
      official_required: true,
    });

    const pool = await repo.listPool(NS);
    expect(pool.map((card) => card.name)).toEqual(["guard"]);
  });

  it("filters out a user-disabled official skill but keeps required ones", async () => {
    await insertSkill(hub.collections, { scope: "official", name: "writer" });
    await insertSkill(hub.collections, {
      scope: "official",
      name: "guard",
      official_required: true,
    });

    await repo.setEnabled(NS, "writer", false); // non-required: user preference persists
    // guard is required → never filtered even without an explicit enable
    const pool = await repo.listPool(NS);
    expect(pool.map((card) => card.name)).toEqual(["guard"]);
  });

  it("refuses to disable a required official skill", async () => {
    await insertSkill(hub.collections, {
      scope: "official",
      name: "guard",
      official_required: true,
    });

    await expect(repo.setEnabled(NS, "guard", false)).rejects.toBeInstanceOf(SkillRequiredError);
  });

  it("removes a soft-deleted skill from the pool", async () => {
    await insertSkill(hub.collections, { scope: "official", name: "writer" });
    await repo.markDeleted("official", "writer");

    expect(await repo.listPool(NS)).toEqual([]);
  });

  it("applies official flags and enforces the new required flag", async () => {
    await insertSkill(hub.collections, { scope: "official", name: "writer" });

    await repo.setOfficialFlags("writer", { required: true });
    await expect(repo.setEnabled(NS, "writer", false)).rejects.toBeInstanceOf(SkillRequiredError);

    await repo.setOfficialFlags("writer", { enabled: false });
    // enabled=false but now required → still visible
    expect((await repo.listPool(NS)).map((card) => card.name)).toEqual(["writer"]);
  });

  it("sums quota usage over namespace-owned, non-deleted skills only", async () => {
    await insertSkill(hub.collections, { scope: NS, name: "one", package_size: 100 });
    await insertSkill(hub.collections, { scope: NS, name: "two", package_size: 250 });
    await insertSkill(hub.collections, { scope: NS, name: "gone", package_size: 999 });
    await insertSkill(hub.collections, { scope: "official", name: "writer", package_size: 500 });
    await repo.markDeleted(NS, "gone");

    expect(await repo.quotaUsage(NS)).toEqual({ packageCount: 2, packageBytes: 350 });
  });

  it("reports zero usage for a namespace with no packages", async () => {
    expect(await repo.quotaUsage("empty-ns")).toEqual({ packageCount: 0, packageBytes: 0 });
  });
});
