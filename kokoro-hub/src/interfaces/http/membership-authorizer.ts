// self 面成员校验器（HUB-AUTHZ）：hub 以 caller=hub 调 user 服务 GET /memberships/check，
// 据 {active, role} 决定 read(member) / write(owner|admin) 放行。scope→teamId 映射由调用点完成
// （当前 personal-team 期 namespace 即 teamId，见 user session-service）。

import { callService, type RequestContext, type ServiceCaller } from "@kokoro/platform-kit";
import { z } from "zod";

export type MembershipRole = "owner" | "admin" | "member";

export interface MembershipCheck {
  active: boolean;
  role: MembershipRole | null;
}

export interface MembershipAuthorizer {
  // teamId 由 self 路由从信封 namespace 头映射得到；userId 来自信封 x-kokoro-user-id 头。
  check(ctx: RequestContext, teamId: string, userId: string): Promise<MembershipCheck>;
}

// user /memberships/check 响应契约的 hub 侧镜像（单源在 kokoro-user schemas；此处独立洗净下游响应）。
const membershipCheckSchema = z.object({
  active: z.boolean(),
  role: z.enum(["owner", "admin", "member"]).nullable(),
});

export interface HttpMembershipAuthorizerOptions {
  userBaseUrl: string;
  // hub 自身出站凭据（caller=hub 的 per-caller secret）；user 侧 route-access 校验 hub 属 runtime-internal。
  internalSecret?: string;
  // 可注入便于测试；缺省全局 fetch。
  fetchImpl?: typeof fetch;
}

export class HttpMembershipAuthorizer implements MembershipAuthorizer {
  private readonly caller: ServiceCaller = "hub";

  constructor(private readonly options: HttpMembershipAuthorizerOptions) {}

  async check(ctx: RequestContext, teamId: string, userId: string): Promise<MembershipCheck> {
    const query = `teamId=${encodeURIComponent(teamId)}&userId=${encodeURIComponent(userId)}`;
    return callService(ctx, {
      baseUrl: this.options.userBaseUrl,
      method: "GET",
      path: `/memberships/check?${query}`,
      schema: membershipCheckSchema,
      caller: this.caller,
      ...(this.options.internalSecret !== undefined ? { internalSecret: this.options.internalSecret } : {}),
      ...(this.options.fetchImpl !== undefined ? { fetchImpl: this.options.fetchImpl } : {}),
    });
  }
}

// 缺省 fail-closed 校验器：未注入真实校验器时一切 self 请求判为非成员（403）。
export const denyAllMembershipAuthorizer: MembershipAuthorizer = {
  check: async () => ({ active: false, role: null }),
};
