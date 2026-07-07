import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "../../generated/prisma/index.js";
import type { ActionRequest } from "../../src/gateway.js";
import { needsApproval } from "../../src/gateway.js";
import {
  approveRequest,
  rejectRequest,
  ApprovalError,
  type ApprovalExecutionResult,
} from "../../src/approval.js";
import type { Operator } from "../../src/rbac.js";

const T = 100_000_000n;
const CHECKER: Operator = {
  id: "op_checker",
  email: "checker@x",
  roleKey: "ops",
  permissions: ["payment.order.refund"],
  scopeSites: ["*"],
};

function makeRequest(overrides: Partial<ActionRequest> = {}): ActionRequest {
  return { moduleId: "credit", resourceId: "credit-accounts", actionId: "grant", ...overrides };
}

describe("needsApproval", () => {
  it("requires approval for any dangerMutation", () => {
    expect(needsApproval("dangerMutation", makeRequest({ actionId: "refund" }), T)).toBe(true);
  });
  it("requires approval for a grant over the threshold", () => {
    expect(needsApproval("mutation", makeRequest({ body: { amountMicros: "200000000" } }), T)).toBe(true);
  });
  it("allows a grant under the threshold", () => {
    expect(needsApproval("mutation", makeRequest({ body: { amountMicros: "50000000" } }), T)).toBe(false);
  });
  it("allows money-free mutations and links", () => {
    expect(needsApproval("mutation", makeRequest({ actionId: "publish" }), T)).toBe(false);
    expect(needsApproval("link", makeRequest(), T)).toBe(false);
  });
  it("requires approval for ANY over-threshold money mutation, not just grant", () => {
    // 杜绝漏标：非 grant 的大额金额动作（调整/退积分等）也必须审批。
    expect(
      needsApproval("mutation", makeRequest({ actionId: "adjust", body: { amountMicros: "200000000" } }), T),
    ).toBe(true);
  });
});

function pendingRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "appr_1",
    status: "pending",
    moduleId: "payment",
    resourceId: "orders",
    actionId: "refund",
    params: { id: "order_1" },
    body: {},
    siteId: "site_1",
    reason: "客户申请",
    requiredPermission: "payment.order.refund",
    executionKey: "k",
    requestedById: "op_maker",
    requestedByEmail: "maker@x",
    ...overrides,
  };
}

// 有状态 fake：updateMany 模拟原子条件转移；forceClaimFail 模拟并发败者。
function statefulPrisma(initial: Record<string, unknown>, forceClaimFail = false) {
  let current: Record<string, unknown> = { ...initial };
  const updateMany = vi.fn(async (args: { where: { status?: string }; data: Record<string, unknown> }) => {
    if (forceClaimFail) return { count: 0 };
    if (args.where.status !== undefined && current.status !== args.where.status) return { count: 0 };
    current = { ...current, ...args.data };
    return { count: 1 };
  });
  const update = vi.fn(async (args: { data: Record<string, unknown> }) => {
    current = { ...current, ...args.data };
    return current;
  });
  const prisma = {
    approvalRequest: {
      findUnique: async () => ({ ...current }),
      findUniqueOrThrow: async () => ({ ...current }),
      updateMany,
      update,
    },
  } as unknown as PrismaClient;
  return { prisma, updateMany, update, get: () => current };
}

describe("approveRequest", () => {
  it("atomically claims then executes, marking executed on success", async () => {
    const exec = vi.fn(async (): Promise<ApprovalExecutionResult> => ({ statusCode: 200 }));
    const fake = statefulPrisma(pendingRow());
    const result = await approveRequest(fake.prisma, "appr_1", CHECKER, exec);
    expect(exec).toHaveBeenCalledTimes(1);
    expect((result as { status: string }).status).toBe("executed");
    expect(fake.updateMany).toHaveBeenCalledTimes(1);
  });

  it("marks failed when execution returns an error status", async () => {
    const exec = async (): Promise<ApprovalExecutionResult> => ({ statusCode: 502, error: "credit offline" });
    const fake = statefulPrisma(pendingRow());
    const result = await approveRequest(fake.prisma, "appr_1", CHECKER, exec);
    expect((result as { status: string }).status).toBe("failed");
  });

  it("blocks self-approval (403) without executing", async () => {
    const exec = vi.fn(async (): Promise<ApprovalExecutionResult> => ({ statusCode: 200 }));
    const fake = statefulPrisma(pendingRow({ requestedById: CHECKER.id }));
    await expect(approveRequest(fake.prisma, "appr_1", CHECKER, exec)).rejects.toMatchObject({ statusCode: 403 });
    expect(exec).not.toHaveBeenCalled();
  });

  it("blocks a checker lacking the action permission (403)", async () => {
    const exec = vi.fn(async (): Promise<ApprovalExecutionResult> => ({ statusCode: 200 }));
    const weak: Operator = { ...CHECKER, permissions: ["credit.account.read"] };
    const fake = statefulPrisma(pendingRow());
    await expect(approveRequest(fake.prisma, "appr_1", weak, exec)).rejects.toBeInstanceOf(ApprovalError);
    expect(exec).not.toHaveBeenCalled();
  });

  it("blocks a checker out of the request's tenant scope (403)", async () => {
    const exec = vi.fn(async (): Promise<ApprovalExecutionResult> => ({ statusCode: 200 }));
    const scoped: Operator = { ...CHECKER, scopeSites: ["site_2"] };
    const fake = statefulPrisma(pendingRow());
    await expect(approveRequest(fake.prisma, "appr_1", scoped, exec)).rejects.toMatchObject({ statusCode: 403 });
    expect(exec).not.toHaveBeenCalled();
  });

  it("is idempotent on an already-decided request: returns it without executing", async () => {
    const exec = vi.fn(async (): Promise<ApprovalExecutionResult> => ({ statusCode: 200 }));
    const fake = statefulPrisma(pendingRow({ status: "executed" }));
    const result = await approveRequest(fake.prisma, "appr_1", CHECKER, exec);
    expect((result as { status: string }).status).toBe("executed");
    expect(exec).not.toHaveBeenCalled();
  });

  it("does not execute when the atomic claim is lost to a concurrent approver", async () => {
    const exec = vi.fn(async (): Promise<ApprovalExecutionResult> => ({ statusCode: 200 }));
    const fake = statefulPrisma(pendingRow(), true);
    await approveRequest(fake.prisma, "appr_1", CHECKER, exec);
    expect(exec).not.toHaveBeenCalled();
  });
});

describe("rejectRequest", () => {
  it("rejects a pending request", async () => {
    const fake = statefulPrisma(pendingRow());
    const result = await rejectRequest(fake.prisma, "appr_1", CHECKER, "重复申请");
    expect((result as { status: string }).status).toBe("rejected");
  });
  it("blocks self-rejection (403)", async () => {
    const fake = statefulPrisma(pendingRow({ requestedById: CHECKER.id }));
    await expect(rejectRequest(fake.prisma, "appr_1", CHECKER)).rejects.toMatchObject({ statusCode: 403 });
  });
});
