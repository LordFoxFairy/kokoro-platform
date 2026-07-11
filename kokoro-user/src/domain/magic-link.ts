// magic-link 一次性登录：持久层只存 token 哈希不存原文；消费=条件转移（防并发双花）。

export const magicLinkDeliveryModes = ["response", "log"] as const;
// response=开发档：一次性 token 直接回响应体（仅限 dev 环境部署）。
// log=只写服务日志（运维/开发从日志取链）；生产邮件投递接入时替换此档落点，本仓不臆造 SMTP。
export type MagicLinkDeliveryMode = (typeof magicLinkDeliveryModes)[number];

export interface MagicLinkRecord {
  id: string;
  siteId: string;
  email: string;
  tokenHash: string;
  expiresAt: Date;
  consumedAt: Date | null;
  supersededAt: Date | null;
  createdAt: Date;
}

export interface IssueMagicLinkInput {
  siteId: string;
  email: string;
  tokenHash: string;
  expiresAt: Date;
  now: Date;
}

export interface MagicLinkRepository {
  // 原子签发：同 (siteId,email) 未消费未作废旧链全部置 supersededAt=now，再落新链。
  issue(input: IssueMagicLinkInput): Promise<MagicLinkRecord>;
  // 条件转移消费：仅当 未消费+未作废+未过期 时置 consumedAt；否则返回 null（并发双花只赢一次）。
  consume(tokenHash: string, now: Date): Promise<MagicLinkRecord | null>;
}

// 消费失败统一一个错误，不区分 过期/已消费/已作废/不存在，避免给探测者 oracle。
export class MagicLinkInvalidError extends Error {
  constructor() {
    super("magic link is invalid, expired, or already used");
    this.name = "MagicLinkInvalidError";
  }
}

export class MagicLinkRateLimitedError extends Error {
  constructor(readonly email: string) {
    super("too many magic link requests for this email");
    this.name = "MagicLinkRateLimitedError";
  }
}

// magic-link 用户在 user 体系里的身份轴：email 即身份，前缀标注 provider（与 auth0| 等外部 id 同列）。
export function magicLinkExternalUserId(email: string): string {
  return `email|${email}`;
}
