import { z } from "zod";
import type { PrismaClient } from "../generated/prisma/index.js";

export interface Operator {
  id: string;
  email: string;
  roleKey: string;
  permissions: string[];
  scopeSites: string[];
}

export class OperatorAuthError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = "OperatorAuthError";
  }
}

// 权限 glob：「*」全通；精确匹配；「prefix.*」前缀匹配（credit.* 覆盖 credit.grant / credit.account.read）。
export function permits(permissions: string[], required: string): boolean {
  return permissions.some((glob) => {
    if (glob === "*" || glob === required) return true;
    return glob.endsWith(".*") && required.startsWith(glob.slice(0, -1));
  });
}

export function requirePermission(operator: Operator, required: string): void {
  if (!permits(operator.permissions, required)) {
    throw new OperatorAuthError(`permission denied: ${required}`, 403);
  }
}

// 租户作用域：scope 含「*」=跨租户超级权限，否则限定到具体 siteId。
export function permitsSite(scopeSites: string[], siteId: string): boolean {
  return scopeSites.includes("*") || scopeSites.includes(siteId);
}

const stringArraySchema = z.array(z.string());

export type OperatorLookup = (email: string) => Promise<Operator>;

export function listOperators(prisma: PrismaClient) {
  return prisma.operatorAccount.findMany({
    select: { id: true, email: true, displayName: true, roleKey: true, status: true },
    orderBy: { email: "asc" },
  });
}

// DB 边界：role.permissions 是 Json，用 Zod 洗成 string[]。
export function createOperatorLookup(prisma: PrismaClient): OperatorLookup {
  return async (email) => {
    const account = await prisma.operatorAccount.findUnique({ where: { email }, include: { role: true } });
    if (!account || account.status !== "active") {
      throw new OperatorAuthError(`unknown or disabled operator: ${email}`, 401);
    }
    return {
      id: account.id,
      email: account.email,
      roleKey: account.roleKey,
      permissions: stringArraySchema.parse(account.role.permissions),
      scopeSites: stringArraySchema.parse(account.scopeSites),
    };
  };
}
