import { describe, expect, it } from "vitest";
import { SessionService } from "../../src/application/session-service.js";
import type { UserService } from "../../src/application/user-service.js";
import type { EnsureUserInput, EnsureUserResult } from "../../src/domain/repository.js";
import { InvalidRuntimeNamespaceError, type SessionTokenClaims } from "../../src/domain/session.js";

const now = new Date("2026-07-11T00:00:00.000Z");
const deletionAudit = { deletedAt: null, deletedBy: null, deleteReason: null };

function ensureResult(teamId: string): EnsureUserResult {
  return {
    user: {
      id: "u1",
      siteId: "site-a",
      externalUserId: "ext-1",
      email: "user@example.com",
      displayName: "User",
      avatarUrl: null,
      status: "active",
      ...deletionAudit,
      createdAt: now,
      updatedAt: now,
    },
    personalTeam: {
      id: teamId,
      siteId: "site-a",
      name: "User's Personal Team",
      slug: null,
      type: "personal",
      ownerUserId: "u1",
      status: "active",
      ...deletionAudit,
      createdAt: now,
      updatedAt: now,
    },
    membership: {
      id: "m1",
      teamId,
      userId: "u1",
      role: "owner",
      status: "active",
      ...deletionAudit,
      createdAt: now,
      updatedAt: now,
    },
  };
}

function stubUserService(teamId: string): {
  userService: UserService;
  ensureCalls: EnsureUserInput[];
} {
  const ensureCalls: EnsureUserInput[] = [];
  const userService = {
    ensureUserWithPersonalTeam: async (input: EnsureUserInput) => {
      ensureCalls.push(input);
      return ensureResult(teamId);
    },
  } as unknown as UserService;
  return { userService, ensureCalls };
}

function captureSigner(): { sign: (c: SessionTokenClaims) => Promise<string>; claims: SessionTokenClaims[] } {
  const claims: SessionTokenClaims[] = [];
  return {
    claims,
    sign: async (c: SessionTokenClaims) => {
      claims.push(c);
      return `signed:${c.sub}`;
    },
  };
}

describe("SessionService.issue", () => {
  it("resolves user+team and signs a token with teamId as namespace", async () => {
    const { userService, ensureCalls } = stubUserService("clteam0001");
    const signer = captureSigner();
    const service = new SessionService(userService, signer, {
      issuer: "kokoro-user",
      ttlSeconds: 3600,
      now: () => now,
    });

    const issued = await service.issue({
      siteId: "site-a",
      externalUserId: "ext-1",
      email: "user@example.com",
    });

    expect(ensureCalls).toEqual([
      { siteId: "site-a", externalUserId: "ext-1", email: "user@example.com" },
    ]);
    expect(issued.namespace).toBe("clteam0001");
    expect(issued.token).toBe("signed:clteam0001");
    expect(issued.team.id).toBe("clteam0001");
    expect(issued.user.id).toBe("u1");

    const iat = Math.floor(now.getTime() / 1000);
    expect(signer.claims).toEqual([
      {
        sub: "clteam0001",
        iss: "kokoro-user",
        siteId: "site-a",
        issuedAtSeconds: iat,
        expiresAtSeconds: iat + 3600,
      },
    ]);
  });

  it("rejects a team id that carries a forbidden identity-axis prefix", async () => {
    const { userService } = stubUserService("team:leaky");
    const signer = captureSigner();
    const service = new SessionService(userService, signer, {
      issuer: "kokoro-user",
      ttlSeconds: 3600,
      now: () => now,
    });

    await expect(
      service.issue({ siteId: "site-a", externalUserId: "ext-1" }),
    ).rejects.toBeInstanceOf(InvalidRuntimeNamespaceError);
    expect(signer.claims).toHaveLength(0);
  });
});
