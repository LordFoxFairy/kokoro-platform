import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "../../generated/prisma/index.js";
import { listRoles, setOperatorStatus, upsertOperator, upsertRole } from "../../src/rbac.js";
import { createAdminServer, type AdminServerDeps } from "../../src/server.js";
import { OperatorAuthError, type Operator } from "../../src/rbac.js";
import type { AuditSink } from "../../src/gateway.js";

const SUPER: Operator = { id: "op_super", email: "admin@kokoro.local", roleKey: "superadmin", permissions: ["*"], scopeSites: ["*"] };
const FINANCE: Operator = { id: "op_fin", email: "fin@kokoro.local", roleKey: "finance", permissions: ["payment.*", "credit.grant"], scopeSites: ["site_1"] };

// Fake prisma：仅实现被测端点触达的方法，按测试断言记录入参。
function fakePrisma(overrides: Record<string, unknown>): PrismaClient {
  return overrides as unknown as PrismaClient;
}

const noopAudit: AuditSink = { record: async () => {} };

function buildDeps(prisma: PrismaClient, operator: Operator | OperatorAuthError): AdminServerDeps {
  return {
    audit: noopAudit,
    prisma,
    approvalGrantThresholdMicros: 100_000_000n,
    resolveOperator: async () => {
      if (operator instanceof OperatorAuthError) throw operator;
      return operator;
    },
  };
}

describe("rbac CRUD washes Json boundaries", () => {
  it("listRoles selects key/name/permissions ordered by key", async () => {
    const findMany = vi.fn(async () => [{ key: "superadmin", name: "Superadmin", permissions: ["*"] }]);
    const result = await listRoles(fakePrisma({ operatorRole: { findMany } }));
    expect(findMany).toHaveBeenCalledWith({ select: { key: true, name: true, permissions: true }, orderBy: { key: "asc" } });
    expect(result[0]?.key).toBe("superadmin");
  });

  it("upsertRole parses permissions to string[] and upserts on key", async () => {
    const upsert = vi.fn(async (arg: unknown) => arg);
    await upsertRole(fakePrisma({ operatorRole: { upsert } }), { key: "ops2", name: "Ops 2", permissions: ["credit.*", "audit.read"] });
    expect(upsert).toHaveBeenCalledWith({
      where: { key: "ops2" },
      create: { key: "ops2", name: "Ops 2", permissions: ["credit.*", "audit.read"] },
      update: { name: "Ops 2", permissions: ["credit.*", "audit.read"] },
    });
  });

  it("upsertRole rejects non-string permission entries (Zod wash)", () => {
    const upsert = vi.fn();
    expect(() => upsertRole(fakePrisma({ operatorRole: { upsert } }), { key: "x", name: "X", permissions: [1 as unknown as string] })).toThrow();
    expect(upsert).not.toHaveBeenCalled();
  });

  it("upsertOperator parses scopeSites and upserts on email", async () => {
    const upsert = vi.fn(async (arg: unknown) => arg);
    await upsertOperator(fakePrisma({ operatorAccount: { upsert } }), { email: "a@b.c", displayName: "A", roleKey: "support", scopeSites: ["site-demo"] });
    expect(upsert).toHaveBeenCalledWith({
      where: { email: "a@b.c" },
      create: { email: "a@b.c", displayName: "A", roleKey: "support", scopeSites: ["site-demo"] },
      update: { displayName: "A", roleKey: "support", scopeSites: ["site-demo"] },
    });
  });

  it("setOperatorStatus updates status by id", async () => {
    const update = vi.fn(async (arg: unknown) => arg);
    await setOperatorStatus(fakePrisma({ operatorAccount: { update } }), "op_1", "disabled");
    expect(update).toHaveBeenCalledWith({ where: { id: "op_1" }, data: { status: "disabled" } });
  });
});

describe("perms endpoints gate on operator.manage", () => {
  it("GET /api/roles returns roles for a superadmin", async () => {
    const findMany = vi.fn(async () => [{ key: "superadmin", name: "Superadmin", permissions: ["*"] }]);
    const app = createAdminServer([], buildDeps(fakePrisma({ operatorRole: { findMany } }), SUPER));
    const res = await app.inject({ method: "GET", url: "/api/roles" });
    expect(res.statusCode).toBe(200);
    expect(res.json().data[0].key).toBe("superadmin");
  });

  it("GET /api/roles denies an operator without operator.manage", async () => {
    const findMany = vi.fn();
    const app = createAdminServer([], buildDeps(fakePrisma({ operatorRole: { findMany } }), FINANCE));
    const res = await app.inject({ method: "GET", url: "/api/roles" });
    expect(res.statusCode).toBe(403);
    expect(findMany).not.toHaveBeenCalled();
  });

  it("POST /api/roles upserts for a superadmin", async () => {
    const upsert = vi.fn(async (arg: { create: unknown }) => arg.create);
    const app = createAdminServer([], buildDeps(fakePrisma({ operatorRole: { upsert } }), SUPER));
    const res = await app.inject({ method: "POST", url: "/api/roles", payload: { key: "ops2", name: "Ops 2", permissions: ["credit.*"] } });
    expect(res.statusCode).toBe(200);
    expect(upsert).toHaveBeenCalledOnce();
  });

  it("POST /api/roles rejects unknown fields (.strict)", async () => {
    const upsert = vi.fn();
    const app = createAdminServer([], buildDeps(fakePrisma({ operatorRole: { upsert } }), SUPER));
    const res = await app.inject({ method: "POST", url: "/api/roles", payload: { key: "x", name: "X", permissions: [], evil: 1 } });
    expect(res.statusCode).toBe(400);
    expect(upsert).not.toHaveBeenCalled();
  });

  it("POST /api/operators denies an operator without operator.manage", async () => {
    const upsert = vi.fn();
    const app = createAdminServer([], buildDeps(fakePrisma({ operatorAccount: { upsert } }), FINANCE));
    const res = await app.inject({ method: "POST", url: "/api/operators", payload: { email: "a@b.c", displayName: "A", roleKey: "support", scopeSites: ["*"] } });
    expect(res.statusCode).toBe(403);
    expect(upsert).not.toHaveBeenCalled();
  });

  it("POST /api/operators upserts for a superadmin", async () => {
    const upsert = vi.fn(async (arg: { create: unknown }) => arg.create);
    const app = createAdminServer([], buildDeps(fakePrisma({ operatorAccount: { upsert } }), SUPER));
    const res = await app.inject({ method: "POST", url: "/api/operators", payload: { email: "a@b.c", displayName: "A", roleKey: "support", scopeSites: ["site-demo"] } });
    expect(res.statusCode).toBe(200);
    expect(upsert).toHaveBeenCalledOnce();
  });

  it("POST /api/operators/:id/status updates status for a superadmin", async () => {
    const update = vi.fn(async (arg: { data: unknown }) => arg.data);
    const app = createAdminServer([], buildDeps(fakePrisma({ operatorAccount: { update } }), SUPER));
    const res = await app.inject({ method: "POST", url: "/api/operators/op_1/status", payload: { status: "disabled" } });
    expect(res.statusCode).toBe(200);
    expect(update).toHaveBeenCalledWith({ where: { id: "op_1" }, data: { status: "disabled" } });
  });

  it("POST /api/operators/:id/status rejects an invalid status value (.strict enum)", async () => {
    const update = vi.fn();
    const app = createAdminServer([], buildDeps(fakePrisma({ operatorAccount: { update } }), SUPER));
    const res = await app.inject({ method: "POST", url: "/api/operators/op_1/status", payload: { status: "banned" } });
    expect(res.statusCode).toBe(400);
    expect(update).not.toHaveBeenCalled();
  });
});
