// Self-service authorization remains an injected owner boundary. The production
// Hub composition fails closed until the PostgreSQL Platform membership contract
// is mounted; it never falls back to the retired MySQL user service.
import type { RequestContext } from "@kokoro/platform-kit";

export type MembershipRole = "owner" | "admin" | "member";

export interface MembershipCheck {
  active: boolean;
  role: MembershipRole | null;
}

export interface MembershipAuthorizer {
  // teamId 由 self 路由从信封 namespace 头映射得到；userId 来自信封 x-kokoro-user-id 头。
  check(ctx: RequestContext, teamId: string, userId: string): Promise<MembershipCheck>;
}

// 缺省 fail-closed 校验器：未注入真实校验器时一切 self 请求判为非成员（403）。
export const denyAllMembershipAuthorizer: MembershipAuthorizer = {
  check: async () => ({ active: false, role: null }),
};
