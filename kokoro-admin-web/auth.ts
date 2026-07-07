import NextAuth from "next-auth";
import Nodemailer from "next-auth/providers/nodemailer";
import { authConfig } from "./auth.config";
import { operatorAdapter } from "@/lib/auth/adapter";
import { sendVerificationRequest } from "@/lib/auth/email";
import { logAuthEvent } from "@/lib/auth/events";
import { prisma } from "@/lib/prisma";
import { env } from "@/lib/env";

const norm = (email: string): string => email.trim().toLowerCase();

// Node runtime：叠加 Prisma adapter + Nodemailer magic-link 到 edge-safe 基础 config。
export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  adapter: operatorAdapter(),
  providers: [
    Nodemailer({
      server: {},
      from: env.EMAIL_FROM,
      maxAge: env.MAGIC_LINK_MAX_AGE,
      sendVerificationRequest,
    }),
  ],
  callbacks: {
    ...authConfig.callbacks,
    // node 侧守门：仅 active 运营账号可发链接/登录（拒陌生邮箱在发信前就挡住），非 active 拒 + 留痕。
    async signIn({ user }) {
      const email = norm(user.email ?? "");
      if (!email) return false;
      const account = await prisma.operatorAccount.findUnique({ where: { email } });
      if (!account || account.status !== "active") {
        await logAuthEvent({ email, event: "denied", reason: account ? "inactive" : "unknown" });
        return false;
      }
      return true;
    },
  },
  events: {
    async signIn({ user }) {
      if (user.email) await logAuthEvent({ email: norm(user.email), event: "signin" });
    },
    async signOut(message) {
      const email = "token" in message ? message.token?.email : undefined;
      if (email) await logAuthEvent({ email: norm(email), event: "signout" });
    },
  },
});
