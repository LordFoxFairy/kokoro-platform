import type { NextAuthConfig } from "next-auth";

// edge-safe：不含 adapter/Nodemailer（Prisma 跑不了 edge）；middleware 与 auth.ts 都 import 它。
export const authConfig = {
  pages: { signIn: "/login", verifyRequest: "/auth/verify", error: "/login" },
  // 会话 8h（dev 免频繁重登；生产可按需收紧）。
  session: { strategy: "jwt" as const, maxAge: 28800, updateAge: 3600 },
  providers: [],
  callbacks: {
    // middleware 守卫：登录页/确认页放行（防死循环），其余需已登录。
    authorized({ auth, request }) {
      const path = request.nextUrl.pathname;
      if (path.startsWith("/login") || path.startsWith("/auth/verify")) return true;
      return Boolean(auth?.user);
    },
    // 显式把身份写入 JWT，不依赖 email-provider + JWT session 组合下的默认行为（实测默认不落 email）。
    jwt({ token, user }) {
      if (user) {
        token.email = user.email;
        token.name = user.name;
      }
      return token;
    },
    // 从 JWT 还原到 session.user：网关头注入与顶栏都靠 email。
    session({ session, token }) {
      if (session.user) {
        if (token.email) session.user.email = token.email;
        if (token.name) session.user.name = token.name;
      }
      return session;
    },
  },
} satisfies NextAuthConfig;
