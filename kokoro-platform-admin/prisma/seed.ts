import { createAdminPrisma } from "../src/prisma.js";

// 运营角色矩阵（做什么）。superadmin 全通；其余按需，含 audit.read 才能看审计。
const ROLES = [
  { key: "superadmin", name: "Superadmin", permissions: ["*"] },
  { key: "ops", name: "Operations", permissions: ["credit.*", "payment.*", "user.*", "model.*", "audit.read", "approval.read"] },
  { key: "finance", name: "Finance", permissions: ["payment.*", "credit.account.read", "credit.grant", "audit.read", "approval.read"] },
  { key: "support", name: "Support", permissions: ["credit.account.read", "credit.grant", "user.read", "payment.order.read", "audit.read", "approval.read"] },
  { key: "readonly", name: "Read-only", permissions: ["credit.account.read", "payment.order.read", "user.read", "audit.read"] },
];

// operator（谁 + 哪个租户）。scopeSites ["*"]=跨租户超级；否则限定 siteId。
const OPERATORS = [
  { id: "op-superadmin", email: "admin@kokoro.local", displayName: "Platform Admin", roleKey: "superadmin", scopeSites: ["*"] },
  { id: "op-support-demo", email: "support-demo@kokoro.local", displayName: "Support (site-demo)", roleKey: "support", scopeSites: ["site-demo"] },
];

const url = process.env.DATABASE_URL_ADMIN;
if (url === undefined || url.length === 0) {
  throw new Error("DATABASE_URL_ADMIN is required to seed operators");
}

const prisma = createAdminPrisma(url);
for (const role of ROLES) {
  await prisma.operatorRole.upsert({
    where: { key: role.key },
    create: role,
    update: { name: role.name, permissions: role.permissions },
  });
}
for (const op of OPERATORS) {
  await prisma.operatorAccount.upsert({
    where: { email: op.email },
    create: op,
    update: { roleKey: op.roleKey, scopeSites: op.scopeSites, displayName: op.displayName },
  });
}
await prisma.$disconnect();
