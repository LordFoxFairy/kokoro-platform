import NextAuth from "next-auth";
import { NextResponse } from "next/server";
import { authConfig } from "./auth.config";

// edge：只用 edge-safe 的 authConfig（JWT 验签，不查 DB）。
const { auth } = NextAuth(authConfig);

const PROXY_SECRET = process.env.KOKORO_ADMIN_PROXY_SECRET ?? "";

export default auth((req) => {
  const { pathname } = req.nextUrl;
  const isAuthPage = pathname.startsWith("/login") || pathname.startsWith("/auth/verify");

  if (!req.auth) {
    if (isAuthPage) return NextResponse.next();
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: { code: "auth.unauthenticated", message: "未登录" } }, { status: 401 });
    }
    return NextResponse.redirect(new URL("/login", req.nextUrl));
  }

  if (isAuthPage) {
    return NextResponse.redirect(new URL("/", req.nextUrl));
  }

  // 已登录：BFF 向网关注入身份 + 内部密钥（网关 proxy 模式消费）。
  if (pathname.startsWith("/api/")) {
    const headers = new Headers(req.headers);
    const email = req.auth.user?.email;
    if (email) headers.set("x-kokoro-operator", email);
    if (PROXY_SECRET) headers.set("x-kokoro-proxy-secret", PROXY_SECRET);
    return NextResponse.next({ request: { headers } });
  }

  return NextResponse.next();
});

export const config = {
  matcher: ["/((?!api/auth|_next/static|_next/image|favicon.ico).*)"],
};
