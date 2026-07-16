import {
  generateRefreshToken,
  hashRefreshToken,
  RefreshTokenInvalidError,
  type RefreshTokenRecord,
  type RefreshTokenRepository,
} from "../domain/refresh-token.js";
import type { SessionSigner } from "../domain/session.js";

export interface RefreshServiceOptions {
  issuer: string;
  // 换发的 access JWT 存活时长（与 session 同 TTL）。
  jwtTtlSeconds: number;
  // refresh token 存活时长。
  refreshTtlSeconds: number;
  // 可注入时钟，便于测试确定 expiresAt/iat/exp；缺省真实时间。
  now?: () => Date;
}

export interface IssuedRefresh {
  // 一次性原文 refresh token：只在签发瞬间存在，持久层只有 SHA-256 哈希。
  refreshToken: string;
  expiresAt: Date;
}

export interface RotatedSession {
  // 新签发的 access JWT。
  token: string;
  namespace: string;
  siteId: string;
  // 轮换后的新 refresh 原文（旧的已被消费作废）。
  refreshToken: string;
  refreshExpiresAt: Date;
}

// refresh token 编排：签发（哈希落库）与轮换（消费旧+签新 access+发新 refresh+登记轮换链）。
export class RefreshService {
  private readonly now: () => Date;

  constructor(
    private readonly repository: RefreshTokenRepository,
    private readonly signer: SessionSigner,
    private readonly options: RefreshServiceOptions,
  ) {
    this.now = options.now ?? (() => new Date());
  }

  // 登录时并行签发：与 access JWT 同 namespace/siteId，落哈希与前缀，返回一次性原文。
  async issue(namespace: string, siteId: string): Promise<IssuedRefresh> {
    const { refreshToken, record } = await this.mint(namespace, siteId, this.now());
    return { refreshToken, expiresAt: record.expiresAt };
  }

  // 用 refresh 换新 access + 轮换 refresh。消费失败（无效/过期/吊销/重放）→ RefreshTokenInvalidError。
  async rotate(refreshToken: string): Promise<RotatedSession> {
    const now = this.now();
    const old = await this.repository.consume(hashRefreshToken(refreshToken), now);
    if (old === null) {
      throw new RefreshTokenInvalidError();
    }

    // (a) 签新 access JWT：复用 session 的签名结构（sub=namespace，siteId passthrough）。
    const issuedAtSeconds = Math.floor(now.getTime() / 1000);
    const token = await this.signer.sign({
      sub: old.namespace,
      iss: this.options.issuer,
      siteId: old.siteId,
      issuedAtSeconds,
      expiresAtSeconds: issuedAtSeconds + this.options.jwtTtlSeconds,
    });

    // (b) 发新 refresh（同 namespace/siteId）(c) 登记轮换链：旧 → 新，供重放检测溯源。
    const minted = await this.mint(old.namespace, old.siteId, now);
    await this.repository.markReplaced(old.id, minted.record.id);

    return {
      token,
      namespace: old.namespace,
      siteId: old.siteId,
      refreshToken: minted.refreshToken,
      refreshExpiresAt: minted.record.expiresAt,
    };
  }

  // 登出/吊销：作废该 refresh 所属 namespace 的全部活 refresh（一次登出即整条会话链失效，
  // 不等 30 天 exp 自然到期）。幂等——无此 token（已轮换/伪造）静默返回，登出不因未知 token 报错。
  async revoke(refreshToken: string): Promise<void> {
    const record = await this.repository.findByHash(hashRefreshToken(refreshToken));
    if (record === null) {
      return;
    }
    await this.repository.revokeAllForNamespace(record.namespace, this.now());
  }

  private async mint(
    namespace: string,
    siteId: string,
    now: Date,
  ): Promise<{ refreshToken: string; record: RefreshTokenRecord }> {
    const refreshToken = generateRefreshToken();
    const record = await this.repository.issue({
      namespace,
      siteId,
      tokenHash: hashRefreshToken(refreshToken),
      // 明文前 12 字符：仅审计/查找（非密），绝不据此还原原文。
      tokenPrefix: refreshToken.slice(0, 12),
      expiresAt: new Date(now.getTime() + this.options.refreshTtlSeconds * 1000),
    });
    return { refreshToken, record };
  }
}
