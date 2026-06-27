import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createUserServer } from "../../src/interfaces/http/server.js";
import { cleanUserDatabase, createTestPrismaClient } from "./helpers.js";

const prisma = createTestPrismaClient();
const app = createUserServer({ prisma });

describe("user HTTP API", () => {
  beforeEach(async () => {
    await cleanUserDatabase(prisma);
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  it("returns module health", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/healthz",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      data: {
        module: "user",
        status: "ok",
      },
    });
  });

  it("ensures a user with a personal team", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/users/ensure",
      headers: {
        "x-request-id": "req_api_1",
      },
      payload: {
        externalUserId: "auth0|api-user",
        email: "api@example.com",
        displayName: "Api User",
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.requestId).toBe("req_api_1");
    expect(body.data.user.externalUserId).toBe("auth0|api-user");
    expect(body.data.personalTeam.type).toBe("personal");
    expect(body.data.membership.role).toBe("owner");
  });

  it("returns a stable personal team for repeated ensure requests", async () => {
    const first = await app.inject({
      method: "POST",
      url: "/users/ensure",
      payload: {
        externalUserId: "auth0|same-user",
        displayName: "Same User",
      },
    });

    const second = await app.inject({
      method: "POST",
      url: "/users/ensure",
      payload: {
        externalUserId: "auth0|same-user",
        displayName: "Same User Updated",
      },
    });

    expect(second.statusCode).toBe(200);
    expect(second.json().data.user.id).toBe(first.json().data.user.id);
    expect(second.json().data.personalTeam.id).toBe(first.json().data.personalTeam.id);
  });

  it("returns a typed error for invalid requests", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/users/ensure",
      headers: {
        "x-request-id": "req_invalid",
      },
      payload: {
        email: "not-an-external-id@example.com",
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      requestId: "req_invalid",
      error: {
        code: "request.invalid",
      },
    });
  });

  it("requires a non-empty user id header when listing teams", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/me/teams",
      headers: {
        "x-request-id": "req_missing_user",
        "x-user-id": "   ",
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      requestId: "req_missing_user",
      error: {
        code: "request.missing_user",
      },
    });
  });
});
