import { generateKeyPairSync } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { loadRsaSigningKey } from "../../src/infrastructure/auth/rsa-keys.js";
import { createUserServer } from "../../src/interfaces/http/server.js";

function rsaPem(): string {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return privateKey.export({ type: "pkcs8", format: "pem" }).toString();
}

const jwksSchema = z.object({
  keys: z
    .array(
      z.object({
        kty: z.literal("RSA"),
        n: z.string().min(1),
        e: z.string().min(1),
        kid: z.string().regex(/^[0-9a-f]{16}$/),
        use: z.literal("sig"),
        alg: z.literal("RS256"),
      }),
    )
    .min(1),
});

// JWKS 端点不触达 DB；注入惰性 PrismaClient，绝不真正连接。
function stubPrisma(): PrismaClient {
  return new PrismaClient({ datasources: { db: { url: "postgresql://x" } } });
}

describe("GET /.well-known/jwks.json", () => {
  it("publishes the current RS256 public key (raw JWKS shape, no data envelope)", async () => {
    const pem = rsaPem();
    const expectedKid = loadRsaSigningKey(pem).kid;
    const prisma = stubPrisma();
    const app = createUserServer({
      prisma,
      sessionSigning: { ttlSeconds: 3600, issuer: "kokoro-user", privateKeyPem: pem },
    });
    try {
      const response = await app.inject({ method: "GET", url: "/.well-known/jwks.json" });
      expect(response.statusCode).toBe(200);
      const body = jwksSchema.parse(response.json());
      expect(body.keys.map((k) => k.kid)).toContain(expectedKid);
      // 绝不泄露私钥分量。
      const raw = response.body;
      expect(raw).not.toMatch(/"d"\s*:/);
    } finally {
      await app.close();
      await prisma.$disconnect();
    }
  });

  it("publishes current + previous keys during rotation", async () => {
    const prisma = stubPrisma();
    const app = createUserServer({
      prisma,
      sessionSigning: {
        ttlSeconds: 3600,
        issuer: "kokoro-user",
        privateKeyPem: rsaPem(),
        previousPrivateKeyPem: rsaPem(),
      },
    });
    try {
      const response = await app.inject({ method: "GET", url: "/.well-known/jwks.json" });
      const body = jwksSchema.parse(response.json());
      expect(body.keys).toHaveLength(2);
    } finally {
      await app.close();
      await prisma.$disconnect();
    }
  });

  it("does not register the JWKS route in the HS256 (dev) fallback", async () => {
    const prisma = stubPrisma();
    const app = createUserServer({
      prisma,
      sessionSigning: { ttlSeconds: 3600, issuer: "kokoro-user", secret: "dev-secret" },
    });
    try {
      const response = await app.inject({ method: "GET", url: "/.well-known/jwks.json" });
      expect(response.statusCode).toBe(404);
    } finally {
      await app.close();
      await prisma.$disconnect();
    }
  });
});
