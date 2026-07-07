import type { NextConfig } from "next";

// 浏览器同源调 /api/*，由 Next 反代到网关，避免 CORS；dev 模式网关默认 operator=admin@kokoro.local。
const gatewayUrl = process.env.KOKORO_GATEWAY_URL ?? "http://127.0.0.1:4290";

// 仅应用语义的响应头。传输层（HSTS）与边缘限流归反代/TLS 终结点（nginx/APISIX），不在此。
const securityHeaders = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  // 后台无需被任何站点内嵌；frame-ancestors 与 X-Frame-Options 双保险。严格 script-src(nonce) 待专项。
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'; base-uri 'self'; form-action 'self'" },
];

const nextConfig: NextConfig = {
  allowedDevOrigins: ["127.0.0.1"],
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
  async rewrites() {
    // fallback：在 dynamic routes 之后才代理，让 /api/auth/* 先命中 Auth.js 的 [...nextauth] route，
    // 其余 /api/*（me/sites/user360…）再反代到网关。
    return {
      fallback: [{ source: "/api/:path*", destination: `${gatewayUrl}/api/:path*` }],
    };
  },
};

export default nextConfig;
