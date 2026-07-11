import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import {
  INTERNAL_SECRET_HEADER,
  registerInternalSecretGuard,
  type InternalSecretGuardOptions,
} from "../src/http/internal-secret-guard.js";

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

function buildApp(options: InternalSecretGuardOptions): FastifyInstance {
  const instance = Fastify({ logger: false });
  registerInternalSecretGuard(instance, options);
  instance.get("/admin/ping", async () => ({ ok: true }));
  instance.get("/credit/grant", async () => ({ ok: true }));
  instance.get("/public/ping", async () => ({ ok: true }));
  app = instance;
  return instance;
}

describe("registerInternalSecretGuard", () => {
  it("secret 已配置：受保护端点缺失头 → 401 fail-closed", async () => {
    const instance = buildApp({ secret: "s3cr3t", protectedPrefixes: ["/admin", "/credit"] });
    const res = await instance.inject({ method: "GET", url: "/admin/ping" });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: { code: "internal.unauthorized" } });
  });

  it("secret 已配置：头不匹配 → 401", async () => {
    const instance = buildApp({ secret: "s3cr3t", protectedPrefixes: ["/admin"] });
    const res = await instance.inject({
      method: "GET",
      url: "/admin/ping",
      headers: { [INTERNAL_SECRET_HEADER]: "wrong" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("secret 已配置：头匹配 → 放行", async () => {
    const instance = buildApp({ secret: "s3cr3t", protectedPrefixes: ["/admin", "/credit"] });
    const res = await instance.inject({
      method: "GET",
      url: "/credit/grant",
      headers: { [INTERNAL_SECRET_HEADER]: "s3cr3t" },
    });
    expect(res.statusCode).toBe(200);
  });

  it("secret 已配置：非受保护路径无需密钥 → 放行", async () => {
    const instance = buildApp({ secret: "s3cr3t", protectedPrefixes: ["/admin"] });
    const res = await instance.inject({ method: "GET", url: "/public/ping" });
    expect(res.statusCode).toBe(200);
  });

  it("secret 未配置(空串)：受保护端点直通 + 仅告警一次", async () => {
    const warnings: string[] = [];
    const instance = buildApp({ secret: "", protectedPrefixes: ["/admin"], warn: (m) => warnings.push(m) });
    const first = await instance.inject({ method: "GET", url: "/admin/ping" });
    const second = await instance.inject({ method: "GET", url: "/admin/ping" });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).not.toContain("s3cr3t");
  });

  it("前缀边界：/administrators 不被 /admin 误伤", async () => {
    const instance = buildApp({ secret: "s3cr3t", protectedPrefixes: ["/admin"] });
    instance.get("/administrators", async () => ({ ok: true }));
    const res = await instance.inject({ method: "GET", url: "/administrators" });
    expect(res.statusCode).toBe(200);
  });
});
