import { registerErrorHandler } from "@kokoro/platform-kit";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { InMemoryMagicLinkRateLimiter } from "../../src/application/magic-link-rate-limiter.js";
import type { RefreshService, RotatedSession } from "../../src/application/refresh-service.js";
import { RefreshTokenInvalidError } from "../../src/domain/refresh-token.js";
import { registerRefreshRoutes } from "../../src/interfaces/http/refresh-routes.js";

const refreshExpiresAt = new Date("2026-08-14T00:00:00.000Z");

function okRefreshService(): RefreshService {
  return {
    rotate: async (refreshToken: string): Promise<RotatedSession> => ({
      token: `access-for:${refreshToken}`,
      namespace: "clteam0001",
      siteId: "site-a",
      refreshToken: "rotated-plain",
      refreshExpiresAt,
    }),
  } as unknown as RefreshService;
}

function invalidRefreshService(): RefreshService {
  return {
    rotate: async () => {
      throw new RefreshTokenInvalidError();
    },
  } as unknown as RefreshService;
}

function buildApp(
  refreshService: RefreshService | null,
  limiter = new InMemoryMagicLinkRateLimiter({ max: 100, ipMax: 1000, windowSeconds: 600 }),
): FastifyInstance {
  const app = Fastify({ logger: false });
  // 与真实 server 一致：Fastify body-schema 校验失败 → 全局错误 hook 映射为 request.invalid（400）。
  registerErrorHandler(app);
  registerRefreshRoutes(app, refreshService, { rateLimiter: limiter, now: () => new Date("2026-07-15T00:00:00.000Z") });
  return app;
}

const apps: FastifyInstance[] = [];
function track(app: FastifyInstance): FastifyInstance {
  apps.push(app);
  return app;
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close()));
});

describe("POST /auth/refresh", () => {
  it("rotates and returns the new access + refresh contract shape", async () => {
    const app = track(buildApp(okRefreshService()));
    const res = await app.inject({
      method: "POST",
      url: "/auth/refresh",
      headers: { "x-kokoro-request-id": "req_refresh" },
      payload: { refresh_token: "old-plain" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.requestId).toBe("req_refresh");
    expect(body.data).toEqual({
      token: "access-for:old-plain",
      namespace: "clteam0001",
      site_id: "site-a",
      refresh_token: "rotated-plain",
      refresh_expires_at: refreshExpiresAt.toISOString(),
    });
  });

  it("maps an invalid/expired/revoked/replayed refresh to a single opaque 401 invalid_refresh", async () => {
    const app = track(buildApp(invalidRefreshService()));
    const res = await app.inject({
      method: "POST",
      url: "/auth/refresh",
      payload: { refresh_token: "whatever" },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("invalid_refresh");
  });

  it("fail-closes with 503 when signing (refreshService) is not configured", async () => {
    const app = track(buildApp(null));
    const res = await app.inject({
      method: "POST",
      url: "/auth/refresh",
      payload: { refresh_token: "x" },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe("auth.not_configured");
  });

  it("rejects an invalid body with 400", async () => {
    const app = track(buildApp(okRefreshService()));
    const res = await app.inject({
      method: "POST",
      url: "/auth/refresh",
      payload: { refresh_token: "" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("request.invalid");
  });

  it("rate limits by IP once the window quota is exhausted (429)", async () => {
    const limiter = new InMemoryMagicLinkRateLimiter({ max: 2, ipMax: 1000, windowSeconds: 600 });
    const app = track(buildApp(okRefreshService(), limiter));
    const payload = { refresh_token: "old-plain" };
    const first = await app.inject({ method: "POST", url: "/auth/refresh", payload });
    const second = await app.inject({ method: "POST", url: "/auth/refresh", payload });
    const third = await app.inject({ method: "POST", url: "/auth/refresh", payload });
    expect([first.statusCode, second.statusCode]).toEqual([200, 200]);
    expect(third.statusCode).toBe(429);
    expect(third.json().error.code).toBe("auth.refresh_rate_limited");
  });
});
