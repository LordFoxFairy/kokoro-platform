import type { Team } from "./team.js";
import type { User } from "./user.js";

// 运行时命名空间禁用前缀：与 kokoro-session src/http/auth.ts 同源不变量。
// namespace 必须不透明，不得携带 user:/team:/site: 等身份轴前缀；teamId(cuid) 天然满足。
export const FORBIDDEN_NAMESPACE_PREFIXES = [
  "user:",
  "owner:",
  "team:",
  "site:",
  "workspace:",
] as const;

export class InvalidRuntimeNamespaceError extends Error {
  constructor(readonly namespace: string) {
    super("namespace must not carry an identity-axis prefix");
    this.name = "InvalidRuntimeNamespaceError";
  }
}

// 签发前守卫：非不透明 namespace 即 fail-loud，绝不签出 session 会拒绝的 token。
export function assertRuntimeNamespace(namespace: string): void {
  if (FORBIDDEN_NAMESPACE_PREFIXES.some((prefix) => namespace.startsWith(prefix))) {
    throw new InvalidRuntimeNamespaceError(namespace);
  }
}

export interface IssueSessionInput {
  siteId: string;
  externalUserId: string;
  email?: string | undefined;
}

// 团队换签入参：以已知 user principal + 目标 teamId 换取该 namespace 的 runtime token。
export interface IssueTeamSessionInput {
  userId: string;
  teamId: string;
}

// 换签时 caller 非目标 team 活跃成员：路由映射 403（不泄露 team 是否存在）。
export class NotTeamMemberError extends Error {
  constructor(
    readonly userId: string,
    readonly teamId: string,
  ) {
    super("caller is not an active member of the target team");
    this.name = "NotTeamMemberError";
  }
}

// 签入 JWT 的声明。sub=namespace(teamId)；session 只强校验 sub/exp，其余 passthrough。
export interface SessionTokenClaims {
  sub: string;
  iss: string;
  siteId: string;
  issuedAtSeconds: number;
  expiresAtSeconds: number;
}

export interface SessionSigner {
  sign(claims: SessionTokenClaims): Promise<string>;
}

export interface IssuedSession {
  token: string;
  namespace: string;
  user: User;
  team: Team;
}
