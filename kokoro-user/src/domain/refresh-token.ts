// 长效 refresh token：持久层只存 token 哈希不存原文；rotate=一次性条件转移（防并发/重放），轮换成链。
import { createHash, randomBytes } from "node:crypto";

export interface RefreshTokenRecord {
  id: string;
  // = team.id（session 的 sub，不透明 namespace）。
  namespace: string;
  siteId: string;
  tokenHash: string;
  // 明文前 12 字符，仅审计/查找（非密）。
  tokenPrefix: string;
  expiresAt: Date;
  // 轮换：消费即置（一次性）。
  consumedAt: Date | null;
  // 吊销。
  revokedAt: Date | null;
  // 轮换链：被哪个新 token 取代（重放检测用）。
  replacedById: string | null;
  createdAt: Date;
}

export interface IssueRefreshTokenInput {
  namespace: string;
  siteId: string;
  tokenHash: string;
  tokenPrefix: string;
  expiresAt: Date;
}

export interface RefreshTokenRepository {
  // 落库：只存哈希与前缀，绝不落原文。
  issue(input: IssueRefreshTokenInput): Promise<RefreshTokenRecord>;
  // 条件转移消费：仅当 未消费+未吊销+未过期 时置 consumedAt=now 并返回该记录；否则返回 null。
  // 重放检测：条件转移未命中且命中一条已消费（consumedAt!=null）记录 → 视为已用 token 被重放，
  // 吊销该 namespace 全部活 refresh（安全兜底），仍返回 null。无效/过期/吊销/重放同一个不透明结果。
  consume(tokenHash: string, now: Date): Promise<RefreshTokenRecord | null>;
  // 轮换链登记：旧记录 replacedById 指向新记录 id。
  markReplaced(oldId: string, newId: string): Promise<void>;
  // 吊销某 namespace 全部尚未吊销的 refresh（重放兜底 / 主动登出全设备）。
  revokeAllForNamespace(namespace: string, now: Date): Promise<void>;
  findByHash(tokenHash: string): Promise<RefreshTokenRecord | null>;
}

// 消费失败统一一个错误，不区分 无效/过期/吊销/重放，避免给探测者 oracle。
export class RefreshTokenInvalidError extends Error {
  constructor() {
    super("refresh token is invalid, expired, revoked, or already used");
    this.name = "RefreshTokenInvalidError";
  }
}

export function hashRefreshToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

// 32 字节 CSPRNG，base64url 无填充（与 magic-link 同格式）；哈希后才落库。
export function generateRefreshToken(): string {
  return randomBytes(32).toString("base64url");
}
