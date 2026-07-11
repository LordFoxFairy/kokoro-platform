// HUB-4 运营位 + 审核状态机（unit）：边界 schema / 服务委派 / 路由错误映射（fake 仓储，无外部依赖）。

import type { FastifyInstance } from "fastify";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { SKILL_CURATION_DEFAULTS } from "../../src/contract/skill-curation-storage.js";
import { hubAdminContract } from "../../src/interfaces/admin/hub-admin-contract.js";
import { createHubServer } from "../../src/interfaces/http/server.js";
import { curationBodySchema, reviewBodySchema } from "../../src/interfaces/http/schemas.js";
import { FakeSkillRepository } from "../doubles/fake-skill-repository.js";

describe("curation body schema", () => {
  it("accepts each field alone", () => {
    expect(curationBodySchema.parse({ display_weight: 10 })).toEqual({ display_weight: 10 });
    expect(curationBodySchema.parse({ pinned: true })).toEqual({ pinned: true });
    expect(curationBodySchema.parse({ category: "writing" })).toEqual({ category: "writing" });
  });

  it("accepts category null (clears the category)", () => {
    expect(curationBodySchema.parse({ category: null })).toEqual({ category: null });
  });

  it("rejects an empty body (meaningless update)", () => {
    expect(curationBodySchema.safeParse({}).success).toBe(false);
  });

  it("rejects a non-integer display_weight", () => {
    expect(curationBodySchema.safeParse({ display_weight: 1.5 }).success).toBe(false);
  });

  it("rejects an empty category string", () => {
    expect(curationBodySchema.safeParse({ category: "  " }).success).toBe(false);
  });

  it("rejects unknown fields", () => {
    expect(curationBodySchema.safeParse({ pinned: true, extra: 1 }).success).toBe(false);
  });
});

describe("review body schema", () => {
  it("accepts the three review states", () => {
    for (const status of ["pending", "approved", "rejected"] as const) {
      expect(reviewBodySchema.parse({ status })).toEqual({ status });
    }
  });

  it("rejects an unknown status", () => {
    expect(reviewBodySchema.safeParse({ status: "banned" }).success).toBe(false);
  });

  it("rejects a missing status", () => {
    expect(reviewBodySchema.safeParse({}).success).toBe(false);
  });
});

describe("curation defaults (read-side backfill for legacy docs)", () => {
  it("defaults to weight 0, unpinned, uncategorized, approved", () => {
    expect(SKILL_CURATION_DEFAULTS).toEqual({
      display_weight: 0,
      pinned: false,
      category: null,
      review_status: "approved",
    });
  });
});

describe("curation/review HTTP routes (fake repository)", () => {
  let repository: FakeSkillRepository;
  let app: FastifyInstance;

  beforeEach(async () => {
    await app?.close();
    repository = new FakeSkillRepository();
    app = createHubServer({ repository, quotaLimits: { maxPackages: 10, maxBytes: 1024 } });
  });

  afterAll(async () => {
    await app.close();
  });

  it("sets curation fields and maps snake_case body to the repository input", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/hub/skills/ns-a/writer/curation",
      payload: { display_weight: 5, pinned: true, category: "writing" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual({ ok: true });
    expect(repository.curationCalls).toEqual([
      {
        scope: "ns-a",
        name: "writer",
        input: { displayWeight: 5, pinned: true, category: "writing" },
      },
    ]);
  });

  it("rejects an empty curation body with 400", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/hub/skills/ns-a/writer/curation",
      payload: {},
    });
    expect(response.statusCode).toBe(400);
    expect(repository.curationCalls).toEqual([]);
  });

  it("maps a missing curation target to 404", async () => {
    repository.notFoundNames.add("ghost");
    const response = await app.inject({
      method: "POST",
      url: "/hub/skills/ns-a/ghost/curation",
      payload: { pinned: true },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("hub.skill_not_found");
  });

  it("sets the review status", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/hub/skills/ns-a/writer/review",
      payload: { status: "rejected" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual({ ok: true });
    expect(repository.reviewCalls).toEqual([{ scope: "ns-a", name: "writer", status: "rejected" }]);
  });

  it("rejects an invalid review status with 400", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/hub/skills/ns-a/writer/review",
      payload: { status: "nope" },
    });
    expect(response.statusCode).toBe(400);
    expect(repository.reviewCalls).toEqual([]);
  });

  it("maps a missing review target to 404", async () => {
    repository.notFoundNames.add("ghost");
    const response = await app.inject({
      method: "POST",
      url: "/hub/skills/ns-a/ghost/review",
      payload: { status: "approved" },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("hub.skill_not_found");
  });

  it("declares the curation/review routes in the admin contract surface", () => {
    expect(hubAdminContract.routes).toContainEqual({
      method: "POST",
      path: "/hub/skills/:scope/:name/curation",
    });
    expect(hubAdminContract.routes).toContainEqual({
      method: "POST",
      path: "/hub/skills/:scope/:name/review",
    });
  });
});
