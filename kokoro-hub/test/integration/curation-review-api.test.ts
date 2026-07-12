// HUB-4 运营位 + 审核状态机（真 Mongo）：池排序规格（pinned desc → display_weight desc → name asc）、
// 审核态过滤（只出 approved；存量无字段 = 视为 approved）、curation/review API、upsert 自动过审。

import type { FastifyInstance } from "fastify";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { MongoSkillRepository } from "../../src/infrastructure/mongo/mongo-skill-repository.js";
import { createHubServer } from "../../src/interfaces/http/server.js";
import { connectTestHub, hubTestDbName, insertSkill, type TestHub } from "./helpers.js";

const NS = "ns-curation";

let hub: TestHub;
let repository: MongoSkillRepository;
let app: FastifyInstance;

async function init(): Promise<void> {
  hub = await connectTestHub(hubTestDbName("curation"));
  repository = new MongoSkillRepository(hub.collections);
  app = createHubServer({ repository, quotaLimits: { maxPackages: 100, maxBytes: 4096 } });
}

const ready = init();

async function poolNames(): Promise<string[]> {
  const response = await app.inject({ method: "GET", url: "/hub/admin/skills/pool", query: { namespace: NS } });
  expect(response.statusCode).toBe(200);
  return response.json().data.skills.map((skill: { name: string }) => skill.name);
}

describe("hub curation + review (real mongo)", () => {
  beforeEach(async () => {
    await ready;
    await hub.clean();
  });

  afterAll(async () => {
    await app.close();
    await hub.dropDatabase();
    await hub.client.close();
  });

  it("orders the pool by pinned desc, display_weight desc, name asc", async () => {
    // pinned 压制一切权重；同 pinned 档内权重降序；同权重按名字升序。
    await insertSkill(hub.collections, { scope: "official", name: "heavy", display_weight: 50 });
    await insertSkill(hub.collections, { scope: "official", name: "pinned-light", pinned: true, display_weight: 1 });
    await insertSkill(hub.collections, { scope: "official", name: "b-mid", display_weight: 10 });
    await insertSkill(hub.collections, { scope: "official", name: "a-mid", display_weight: 10 });

    expect(await poolNames()).toEqual(["pinned-light", "heavy", "a-mid", "b-mid"]);
  });

  it("treats legacy docs without curation fields as weight 0 and unpinned", async () => {
    // skillFixture 不带新字段 = 存量文档形状；读侧缺省 weight 0/unpinned，排在加权项之后。
    await insertSkill(hub.collections, { scope: "official", name: "legacy" });
    await insertSkill(hub.collections, { scope: "official", name: "weighted", display_weight: 1 });
    await insertSkill(hub.collections, { scope: "official", name: "another-legacy" });

    expect(await poolNames()).toEqual(["weighted", "another-legacy", "legacy"]);
  });

  it("keeps namespace-over-official dedupe while sorting across scopes", async () => {
    // 自有包覆盖同名 official（哪怕 official 置顶）；排序在去重后的合并池上进行。
    await insertSkill(hub.collections, { scope: "official", name: "writer", pinned: true });
    await insertSkill(hub.collections, { scope: NS, name: "writer" });
    await insertSkill(hub.collections, { scope: NS, name: "mine", pinned: true });

    const response = await app.inject({ method: "GET", url: "/hub/admin/skills/pool", query: { namespace: NS } });
    const skills = response.json().data.skills;
    expect(skills.map((skill: { name: string; scope: string }) => [skill.name, skill.scope])).toEqual([
      ["mine", NS],
      ["writer", NS],
    ]);
  });

  it("filters pending and rejected out of the pool; missing review_status counts as approved", async () => {
    await insertSkill(hub.collections, { scope: "official", name: "ok", review_status: "approved" });
    await insertSkill(hub.collections, { scope: "official", name: "waiting", review_status: "pending" });
    await insertSkill(hub.collections, { scope: "official", name: "bad", review_status: "rejected" });
    await insertSkill(hub.collections, { scope: "official", name: "legacy" }); // 无字段 = approved

    expect(await poolNames()).toEqual(["legacy", "ok"]);
  });

  it("updates curation fields over HTTP and reorders the pool", async () => {
    await insertSkill(hub.collections, { scope: "official", name: "alpha" });
    await insertSkill(hub.collections, { scope: "official", name: "beta" });
    expect(await poolNames()).toEqual(["alpha", "beta"]);

    const response = await app.inject({
      method: "POST",
      url: "/hub/admin/skills/official/beta/curation",
      payload: { pinned: true, display_weight: 7, category: "featured" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual({ ok: true });

    expect(await poolNames()).toEqual(["beta", "alpha"]);
    const doc = await hub.collections.skills.findOne({ scope: "official", name: "beta" });
    expect(doc).toMatchObject({ pinned: true, display_weight: 7, category: "featured" });
  });

  it("returns 404 when curating a missing or soft-deleted skill", async () => {
    const missing = await app.inject({
      method: "POST",
      url: "/hub/admin/skills/official/ghost/curation",
      payload: { pinned: true },
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe("hub.skill_not_found");

    await insertSkill(hub.collections, { scope: "official", name: "gone", deleted_at: Date.now() });
    const deleted = await app.inject({
      method: "POST",
      url: "/hub/admin/skills/official/gone/curation",
      payload: { pinned: true },
    });
    expect(deleted.statusCode).toBe(404);
  });

  it("drives the review state machine over HTTP: reject drops from pool, approve restores", async () => {
    await insertSkill(hub.collections, { scope: "official", name: "writer" });
    expect(await poolNames()).toEqual(["writer"]);

    const rejected = await app.inject({
      method: "POST",
      url: "/hub/admin/skills/official/writer/review",
      payload: { status: "rejected" },
    });
    expect(rejected.statusCode).toBe(200);
    expect(await poolNames()).toEqual([]);

    const approved = await app.inject({
      method: "POST",
      url: "/hub/admin/skills/official/writer/review",
      payload: { status: "approved" },
    });
    expect(approved.statusCode).toBe(200);
    expect(await poolNames()).toEqual(["writer"]);
  });

  it("returns 404 when reviewing a missing skill", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/hub/admin/skills/official/ghost/review",
      payload: { status: "pending" },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("hub.skill_not_found");
  });

  it("auto-approves on upsert and seeds curation defaults on first insert", async () => {
    // V1 自动过审：发布产物默认 approved；运营位缺省仅首插种入。
    const result = await repository.upsertSkill({
      scope: NS,
      name: "fresh",
      description: "d",
      skillMd: "# fresh",
      filesManifest: [{ path: "SKILL.md", size: 7 }],
      fileCount: 1,
      packageSize: 7,
      contentHash: "hash-v1",
      packageRef: `skills/${NS}/fresh/hash-v1.zip`,
      source: "upload",
    });
    expect(result).toEqual({ revision: 1, changed: true });

    const doc = await hub.collections.skills.findOne({ scope: NS, name: "fresh" });
    expect(doc).toMatchObject({
      review_status: "approved",
      display_weight: 0,
      pinned: false,
      category: null,
    });
  });

  it("preserves operator curation across re-publish and re-approves rejected content", async () => {
    await repository.upsertSkill({
      scope: NS,
      name: "evolve",
      description: "d",
      skillMd: "# evolve",
      filesManifest: [{ path: "SKILL.md", size: 8 }],
      fileCount: 1,
      packageSize: 8,
      contentHash: "hash-v1",
      packageRef: `skills/${NS}/evolve/hash-v1.zip`,
      source: "upload",
    });
    await repository.setCuration(NS, "evolve", { pinned: true, displayWeight: 3 });
    await repository.setReviewStatus(NS, "evolve", "rejected");

    const upserted = await repository.upsertSkill({
      scope: NS,
      name: "evolve",
      description: "d2",
      skillMd: "# evolve v2",
      filesManifest: [{ path: "SKILL.md", size: 11 }],
      fileCount: 1,
      packageSize: 11,
      contentHash: "hash-v2",
      packageRef: `skills/${NS}/evolve/hash-v2.zip`,
      source: "upload",
    });
    expect(upserted).toEqual({ revision: 2, changed: true });

    const doc = await hub.collections.skills.findOne({ scope: NS, name: "evolve" });
    // 运营位保留（$setOnInsert 只在首插写缺省）；新内容 = 新审核对象，V1 自动回到 approved。
    expect(doc).toMatchObject({ pinned: true, display_weight: 3, review_status: "approved" });
  });
});
