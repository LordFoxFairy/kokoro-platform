// 内置目录 seed 入口（`pnpm run seed:builtin`）：连库 → service → 幂等落地平台内置默认目录。
// 任何环境（dev/prod）都跑这一个入口取得一致内置目录；编排层不再各自硬编码定义。
import { ModelService } from "../../application/model-service.js";
import { PrismaModelRepository } from "../../infrastructure/prisma/prisma-model-repository.js";
import { createPrismaClient } from "../../infrastructure/prisma/prisma-client.js";
import { BUILTIN_CATALOG, seedBuiltinCatalog } from "./builtin-catalog.js";

const prisma = createPrismaClient();
try {
  const service = new ModelService(new PrismaModelRepository(prisma));
  const result = await seedBuiltinCatalog(service);
  // 只报形态与 id，不泄露凭据（secretRef 是 env 引用，本就不含明文）。
  console.log(
    `[seed:builtin] ok — provider=${BUILTIN_CATALOG.provider.key} binding=${result.bindingId} label=${result.label.key}`,
  );
} finally {
  await prisma.$disconnect();
}
