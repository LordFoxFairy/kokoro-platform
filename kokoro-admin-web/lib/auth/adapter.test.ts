import { describe, it, expect, vi, beforeEach } from "vitest";

const findUnique = vi.fn();
const vtCreate = vi.fn();
const vtDelete = vi.fn();

vi.mock("@/lib/prisma", () => ({
  prisma: {
    operatorAccount: { findUnique },
    verificationToken: { create: vtCreate, delete: vtDelete },
  },
}));

const { operatorAdapter } = await import("@/lib/auth/adapter");
const adapter = operatorAdapter();
const ACTIVE = { id: "op-1", email: "admin@kokoro.local", displayName: "Admin", status: "active" };

beforeEach(() => vi.clearAllMocks());

describe("getUserByEmail", () => {
  it("active account → AdapterUser（emailVerified 恒 null）", async () => {
    findUnique.mockResolvedValue(ACTIVE);
    expect(await adapter.getUserByEmail!("admin@kokoro.local")).toEqual({
      id: "op-1",
      email: "admin@kokoro.local",
      emailVerified: null,
      name: "Admin",
    });
  });

  it("邮箱规范化 trim+lowercase 后查询", async () => {
    findUnique.mockResolvedValue(ACTIVE);
    await adapter.getUserByEmail!("  Admin@KOKORO.local  ");
    expect(findUnique).toHaveBeenCalledWith({ where: { email: "admin@kokoro.local" } });
  });

  it("非 active → null", async () => {
    findUnique.mockResolvedValue({ ...ACTIVE, status: "disabled" });
    expect(await adapter.getUserByEmail!("admin@kokoro.local")).toBeNull();
  });

  it("不存在 → null", async () => {
    findUnique.mockResolvedValue(null);
    expect(await adapter.getUserByEmail!("nobody@x.z")).toBeNull();
  });
});

describe("createUser", () => {
  it("陌生邮箱一律拒（AccessDenied）", async () => {
    await expect(
      adapter.createUser!({ id: "", email: "stranger@evil.com", emailVerified: null }),
    ).rejects.toThrow("AccessDenied");
  });
});

describe("useVerificationToken", () => {
  it("原子取删成功 → 返回记录，identifier 已规范化", async () => {
    const rec = { identifier: "admin@kokoro.local", token: "t", expires: new Date() };
    vtDelete.mockResolvedValue(rec);
    expect(await adapter.useVerificationToken!({ identifier: "Admin@Kokoro.local", token: "t" })).toEqual(rec);
    expect(vtDelete).toHaveBeenCalledWith({
      where: { identifier_token: { identifier: "admin@kokoro.local", token: "t" } },
    });
  });

  it("不存在/已被消费 → null（吞 P2025）", async () => {
    vtDelete.mockRejectedValue(new Error("P2025"));
    expect(await adapter.useVerificationToken!({ identifier: "a@b.c", token: "t" })).toBeNull();
  });
});

describe("updateUser（回归：next-auth 验证后传入仅 {id,emailVerified}）", () => {
  it("必须回查返回完整 user，不能回显残缺入参", async () => {
    findUnique.mockResolvedValue(ACTIVE);
    expect(await adapter.updateUser!({ id: "op-1", emailVerified: new Date() })).toEqual({
      id: "op-1",
      email: "admin@kokoro.local",
      emailVerified: null,
      name: "Admin",
    });
  });

  it("账号消失/停用 → AccessDenied", async () => {
    findUnique.mockResolvedValue(null);
    await expect(adapter.updateUser!({ id: "gone", emailVerified: new Date() })).rejects.toThrow("AccessDenied");
  });
});
