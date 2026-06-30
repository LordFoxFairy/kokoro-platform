import { PrismaClient } from "../generated/prisma/index.js";

export function createAdminPrisma(url: string): PrismaClient {
  return new PrismaClient({ datasources: { db: { url } } });
}
