import { createTransport } from "nodemailer";
import { assertSmtpConfigured, env } from "@/lib/env";

// 未配 SMTP（dev）时打 server console；配了则真发信。生产 env 校验已强制 SMTP 齐全。
export async function sendVerificationRequest(params: { identifier: string; url: string }): Promise<void> {
  assertSmtpConfigured(env);
  const minutes = Math.round(env.MAGIC_LINK_MAX_AGE / 60);

  if (!env.EMAIL_SERVER_HOST) {
    console.log(
      `\n═══════ magic-link 登录 ═══════\n  收件: ${params.identifier}\n  链接: ${params.url}\n  有效: ${minutes} 分钟\n══════════════════════════════\n`,
    );
    return;
  }

  const transport = createTransport({
    host: env.EMAIL_SERVER_HOST,
    port: env.EMAIL_SERVER_PORT,
    auth: env.EMAIL_SERVER_USER ? { user: env.EMAIL_SERVER_USER, pass: env.EMAIL_SERVER_PASSWORD } : undefined,
  });

  await transport.sendMail({
    to: params.identifier,
    from: env.EMAIL_FROM,
    subject: "Kokoro 管理后台登录链接",
    text: `点击登录（${minutes} 分钟内有效）：${params.url}\n若非本人操作，请忽略此邮件。`,
    html: `<p>点击登录（<strong>${minutes} 分钟</strong>内有效）：</p><p><a href="${params.url}">${params.url}</a></p><p style="color:#888;font-size:12px">若非本人操作，请忽略此邮件。</p>`,
  });
}
