import { z } from "zod";
import type { PrismaClient } from "../generated/prisma/index.js";

export interface Operator {
  id: string;
  email: string;
  roleKey: string;
  permissions: string[];
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

const permissionsSchema = z.array(z.string());

export type OperatorLookup = (email: string) => Promise<Operator>;

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
      permissions: permissionsSchema.parse(account.role.permissions),
    };
  };
}
