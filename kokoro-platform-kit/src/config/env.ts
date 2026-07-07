import type { ZodType } from "zod";

// 环境变量校验失败的载体；含逐项问题，供服务入口 fail-loud 打印后退出。
export class EnvValidationError extends Error {
  constructor(readonly issues: string[]) {
    super(`环境变量校验失败:\n${issues.join("\n")}`);
    this.name = "EnvValidationError";
  }
}

// 启动期校验环境变量并返回强类型配置；非法即抛 EnvValidationError，杜绝脏配置潜伏到运行时。
export function defineEnv<T>(
  schema: ZodType<T>,
  source: Record<string, string | undefined> = process.env,
): T {
  const result = schema.safeParse(source);
  if (result.success) {
    return result.data;
  }
  const issues = result.error.issues.map(
    (issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`,
  );
  throw new EnvValidationError(issues);
}
