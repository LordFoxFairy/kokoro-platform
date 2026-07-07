import { prisma } from "@/lib/prisma";

// 审计留痕：signin/signout/denied 写 auth_events。写失败绝不阻断登录流程。
export async function logAuthEvent(e: {
  email: string;
  event: "signin" | "signout" | "denied";
  reason?: string;
}): Promise<void> {
  try {
    await prisma.authEvent.create({
      data: { email: e.email, event: e.event, reason: e.reason ?? null },
    });
  } catch {
    // 审计非关键路径：吞异常，避免因留痕失败挡住用户登录
  }
}
