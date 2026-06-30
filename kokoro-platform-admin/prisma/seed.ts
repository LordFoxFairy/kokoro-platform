import { createAdminPrisma } from "../src/prisma.js";

// 运营角色矩阵 + 默认 superadmin。幂等 upsert，可重复跑。
const ROLES = [
  { key: "superadmin", name: "Superadmin", permissions: ["*"] },
  { key: "ops", name: "Operations", permissions: ["credit.*", "payment.*", "user.*", "model.*"] },
  { key: "finance", name: "Finance", permissions: ["payment.*", "credit.grant"] },
  { key: "support", name: "Support", permissions: ["credit.grant", "user.disable", "payment.order.refund"] },
  { key: "readonly", name: "Read-only", permissions: [] },
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
await prisma.operatorAccount.upsert({
  where: { email: "admin@kokoro.local" },
  create: { email: "admin@kokoro.local", displayName: "Platform Admin", roleKey: "superadmin" },
  update: {},
});
await prisma.$disconnect();
