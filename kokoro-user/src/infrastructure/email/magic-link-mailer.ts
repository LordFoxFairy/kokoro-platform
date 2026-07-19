// magic-link 邮件投递（生产 smtp 档）。原文 token 只进邮件正文,不回响应体、不落日志。
// 边界隔离:SMTP 细节封在此,路由只依赖 MagicLinkMailer 窄口。
import { createTransport, type Transporter } from "nodemailer";

export interface MagicLinkDelivery {
  to: string;
  // 完整可点登录链（= <linkBaseUrl>?token=<原文 token>）。
  url: string;
  expiresInSeconds: number;
}

// 路由只依赖此窄口；测试可替身,生产=SMTP 实现。
export interface MagicLinkMailer {
  send(delivery: MagicLinkDelivery): Promise<void>;
}

export interface SmtpMailerConfig {
  host: string;
  port: number;
  user?: string | undefined;
  password?: string | undefined;
  from: string;
}

export function createSmtpMagicLinkMailer(config: SmtpMailerConfig): MagicLinkMailer {
  const transport: Transporter = createTransport({
    host: config.host,
    port: config.port,
    // 465=隐式 TLS；其余端口用 STARTTLS（nodemailer 依 secure 判定）。
    secure: config.port === 465,
    ...(config.user !== undefined
      ? { auth: { user: config.user, pass: config.password ?? "" } }
      : {}),
  });

  return {
    async send({ to, url, expiresInSeconds }) {
      const minutes = Math.max(1, Math.round(expiresInSeconds / 60));
      await transport.sendMail({
        to,
        from: config.from,
        subject: "Kokoro 登录链接",
        text: `点击登录（${minutes} 分钟内有效）：${url}\n\n若非本人操作，请忽略此邮件。`,
        html:
          `<p>点击登录（<strong>${minutes} 分钟</strong>内有效）：</p>` +
          `<p><a href="${url}">${url}</a></p>` +
          `<p style="color:#888;font-size:12px">若非本人操作，请忽略此邮件。</p>`,
      });
    },
  };
}
