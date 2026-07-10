import {
  assertRuntimeNamespace,
  type IssueSessionInput,
  type IssuedSession,
  type SessionSigner,
} from "../domain/session.js";
import type { UserService } from "./user-service.js";

export interface SessionServiceOptions {
  issuer: string;
  ttlSeconds: number;
  // 可注入时钟，便于测试确定 iat/exp；缺省真实时间。
  now?: () => Date;
}

// 终端用户会话签发编排：resolve-or-create user+personal team → 以 teamId 为 namespace 签发 HS256 JWT。
export class SessionService {
  private readonly now: () => Date;

  constructor(
    private readonly userService: UserService,
    private readonly signer: SessionSigner,
    private readonly options: SessionServiceOptions,
  ) {
    this.now = options.now ?? (() => new Date());
  }

  async issue(input: IssueSessionInput): Promise<IssuedSession> {
    const { user, personalTeam } = await this.userService.ensureUserWithPersonalTeam({
      siteId: input.siteId,
      externalUserId: input.externalUserId,
      email: input.email,
    });

    const namespace = personalTeam.id;
    // 签发即守 session 的不透明 namespace 不变量；teamId(cuid) 恒满足，异常即 fail-loud。
    assertRuntimeNamespace(namespace);

    const issuedAtSeconds = Math.floor(this.now().getTime() / 1000);
    const token = await this.signer.sign({
      sub: namespace,
      iss: this.options.issuer,
      siteId: input.siteId,
      issuedAtSeconds,
      expiresAtSeconds: issuedAtSeconds + this.options.ttlSeconds,
    });

    return { token, namespace, user, team: personalTeam };
  }
}
