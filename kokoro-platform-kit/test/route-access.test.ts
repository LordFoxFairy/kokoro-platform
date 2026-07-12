import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import {
  declareRouteAccess,
  loadCallerSecrets,
  MissingCallerCredentialError,
  registerRouteAccess,
  SERVICE_CALLER_HEADER,
  type RouteAccessConfig,
} from "../src/http/route-access.js";
import { INTERNAL_SECRET_HEADER } from "../src/http/internal-secret-guard.js";

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

// 六模块共同矩阵样例：public healthz / web-bff magic-links / runtime-internal 默认 / admin。
function buildApp(config: Partial<RouteAccessConfig> = {}): FastifyInstance {
  const instance = Fastify({ logger: false });
  registerRouteAccess(instance, {
    secrets: {},
    isProduction: false,
    ...config,
  });
  declareRouteAccess(instance, { path: "/healthz", exact: true }, "public");
  declareRouteAccess(instance, "/auth/magic-links", "web-bff");
  declareRouteAccess(instance, "/auth/sessions", "runtime-internal");
  declareRouteAccess(instance, "/admin", "admin");
  instance.get("/healthz", async () => ({ ok: true }));
  instance.post("/auth/magic-links", async () => ({ ok: true }));
  instance.post("/auth/magic-links/consume", async () => ({ ok: true }));
  instance.post("/auth/sessions", async () => ({ ok: true }));
  instance.get("/credit/usage/hold", async () => ({ ok: true }));
  instance.get("/admin/ping", async () => ({ ok: true }));
  app = instance;
  return instance;
}

const SECRETS = {
  session: "sec-session",
  "web-bff": "sec-webbff",
  admin: "sec-admin",
  credit: "sec-credit",
} as const;

describe("registerRouteAccess — 访问等级解析", () => {
  it("public 路由无需凭据即放行（即使已配置 secret）", async () => {
    const instance = buildApp({ secrets: SECRETS });
    const res = await instance.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
  });

  it("未声明路由默认 runtime-internal", async () => {
    const instance = buildApp({ secrets: SECRETS });
    const res = await instance.inject({
      method: "GET",
      url: "/credit/usage/hold",
      headers: { [SERVICE_CALLER_HEADER]: "session", [INTERNAL_SECRET_HEADER]: SECRETS.session },
    });
    expect(res.statusCode).toBe(200);
  });

  it("最长前缀命中：/auth/magic-links/consume 归 web-bff 而非 /auth/sessions", async () => {
    const instance = buildApp({ secrets: SECRETS });
    const res = await instance.inject({
      method: "POST",
      url: "/auth/magic-links/consume",
      headers: { [SERVICE_CALLER_HEADER]: "web-bff", [INTERNAL_SECRET_HEADER]: SECRETS["web-bff"] },
    });
    expect(res.statusCode).toBe(200);
  });
});

describe("registerRouteAccess — 负向矩阵", () => {
  it("无 caller 头 → 401", async () => {
    const instance = buildApp({ secrets: SECRETS });
    const res = await instance.inject({ method: "GET", url: "/admin/ping" });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: { code: "internal.unauthorized" } });
  });

  it("未知 caller → 401", async () => {
    const instance = buildApp({ secrets: SECRETS });
    const res = await instance.inject({
      method: "GET",
      url: "/admin/ping",
      headers: { [SERVICE_CALLER_HEADER]: "bogus", [INTERNAL_SECRET_HEADER]: "whatever" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("已知 caller 但 secret 不符 → 401", async () => {
    const instance = buildApp({ secrets: SECRETS });
    const res = await instance.inject({
      method: "GET",
      url: "/admin/ping",
      headers: { [SERVICE_CALLER_HEADER]: "admin", [INTERNAL_SECRET_HEADER]: "wrong" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("runtime 凭据打 admin 路由 → 403（authn 过、authz 拒）", async () => {
    const instance = buildApp({ secrets: SECRETS });
    const res = await instance.inject({
      method: "GET",
      url: "/admin/ping",
      headers: { [SERVICE_CALLER_HEADER]: "session", [INTERNAL_SECRET_HEADER]: SECRETS.session },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: { code: "internal.forbidden" } });
  });

  it("web-bff 凭据打 runtime-internal 路由 → 403（等级隔离）", async () => {
    const instance = buildApp({ secrets: SECRETS });
    const res = await instance.inject({
      method: "POST",
      url: "/auth/sessions",
      headers: { [SERVICE_CALLER_HEADER]: "web-bff", [INTERNAL_SECRET_HEADER]: SECRETS["web-bff"] },
    });
    expect(res.statusCode).toBe(403);
  });

  it("admin 凭据打 admin 路由 → 放行", async () => {
    const instance = buildApp({ secrets: SECRETS });
    const res = await instance.inject({
      method: "GET",
      url: "/admin/ping",
      headers: { [SERVICE_CALLER_HEADER]: "admin", [INTERNAL_SECRET_HEADER]: SECRETS.admin },
    });
    expect(res.statusCode).toBe(200);
  });
});

describe("registerRouteAccess — dev 直通与显式测试口", () => {
  it("dev 未配凭据：内部路由直通 + 仅告警一次", async () => {
    const warnings: string[] = [];
    const instance = buildApp({ secrets: {}, isProduction: false, warn: (m) => warnings.push(m) });
    const first = await instance.inject({ method: "GET", url: "/admin/ping" });
    const second = await instance.inject({ method: "GET", url: "/admin/ping" });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).not.toContain("sec-");
  });

  it("insecureLocal=true：即使已配 secret 也全直通", async () => {
    const instance = buildApp({ secrets: SECRETS, insecureLocal: true });
    const res = await instance.inject({ method: "GET", url: "/admin/ping" });
    expect(res.statusCode).toBe(200);
  });

  it("生产未配凭据（无 requiredCallers）：内部路由 401 不直通", async () => {
    const instance = buildApp({ secrets: {}, isProduction: true });
    const res = await instance.inject({ method: "GET", url: "/admin/ping" });
    expect(res.statusCode).toBe(401);
  });
});

describe("registerRouteAccess — 生产 fail-fast", () => {
  it("生产缺 requiredCaller 凭据 → registerRouteAccess 同步抛错", () => {
    const instance = Fastify({ logger: false });
    expect(() =>
      registerRouteAccess(instance, {
        secrets: { admin: "sec-admin" },
        isProduction: true,
        requiredCallers: ["admin", "session", "credit"],
      }),
    ).toThrow(MissingCallerCredentialError);
  });

  it("生产凭据齐备 → 不抛", () => {
    const instance = Fastify({ logger: false });
    app = instance;
    expect(() =>
      registerRouteAccess(instance, {
        secrets: { admin: "a", session: "s" },
        isProduction: true,
        requiredCallers: ["admin", "session"],
      }),
    ).not.toThrow();
  });

  it("insecureLocal 绕过生产 fail-fast（测试构造器）", () => {
    const instance = Fastify({ logger: false });
    app = instance;
    expect(() =>
      registerRouteAccess(instance, {
        secrets: {},
        isProduction: true,
        insecureLocal: true,
        requiredCallers: ["admin"],
      }),
    ).not.toThrow();
  });
});

describe("loadCallerSecrets", () => {
  it("按 KOKORO_INTERNAL_SECRET_<CALLER> 读取，连字符转下划线，空串忽略", () => {
    const secrets = loadCallerSecrets({
      KOKORO_INTERNAL_SECRET_SESSION: "s1",
      KOKORO_INTERNAL_SECRET_WEB_BFF: "s2",
      KOKORO_INTERNAL_SECRET_ADMIN: "",
      IRRELEVANT: "x",
    });
    expect(secrets).toEqual({ session: "s1", "web-bff": "s2" });
  });
});
