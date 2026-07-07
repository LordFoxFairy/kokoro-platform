import type { Adapter, AdapterUser, VerificationToken } from "next-auth/adapters";
import { prisma } from "@/lib/prisma";

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function toAdapterUser(account: { id: string; email: string; displayName: string }): AdapterUser {
  // emailVerified 恒 null：OperatorAccount 无此列；邮箱所有权由 magic-link 即时保证，不落库。
  return { id: account.id, email: account.email, emailVerified: null, name: account.displayName };
}

// 自定义 adapter：认证只证「拥有邮箱」，授权仍归网关 RBAC。桥接既有 OperatorAccount，不引入 Auth.js User 全家桶。
export function operatorAdapter(): Adapter {
  return {
    async getUserByEmail(email) {
      const account = await prisma.operatorAccount.findUnique({ where: { email: normalizeEmail(email) } });
      if (!account || account.status !== "active") return null;
      return toAdapterUser(account);
    },

    async getUser(id) {
      const account = await prisma.operatorAccount.findUnique({ where: { id } });
      if (!account || account.status !== "active") return null;
      return toAdapterUser(account);
    },

    async createUser() {
      // 陌生邮箱不建账号——运营账号由管理员显式创建；兜底陌生邮箱走到此即拒。
      throw new Error("AccessDenied");
    },

    async createVerificationToken(token) {
      await prisma.verificationToken.create({
        data: { identifier: normalizeEmail(token.identifier), token: token.token, expires: token.expires },
      });
      return token;
    },

    async useVerificationToken({ identifier, token }) {
      try {
        const deleted = await prisma.verificationToken.delete({
          where: { identifier_token: { identifier: normalizeEmail(identifier), token } },
        });
        return deleted as VerificationToken;
      } catch {
        // 不存在或已被消费（原子删除）
        return null;
      }
    },

    // 单 provider + JWT session 下不需要 account/session 表：no-op 保持流程不报错。
    async getUserByAccount() {
      return null;
    },
    async linkAccount() {
      return undefined;
    },
    async updateUser(user) {
      // magic-link 验证后 next-auth 调本方法写 emailVerified（本模型无此列，忽略）。
      // 必须回查返回完整 user——next-auth 拿此返回值填 JWT，只回传入参会丢 email/name。
      const account = await prisma.operatorAccount.findUnique({ where: { id: user.id } });
      if (!account || account.status !== "active") throw new Error("AccessDenied");
      return toAdapterUser(account);
    },
  };
}
