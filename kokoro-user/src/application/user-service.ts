import { UserNotFoundError } from "../domain/errors.js";
import type {
  EnsureUserInput,
  EnsureUserResult,
  TeamSummary,
  UserRepository,
} from "../domain/repository.js";
import type { User } from "../domain/user.js";

export class UserService {
  constructor(private readonly repository: UserRepository) {}

  async ensureUserWithPersonalTeam(input: EnsureUserInput): Promise<EnsureUserResult> {
    return this.repository.ensureUserWithPersonalTeam(input);
  }

  // 幂等：已 disabled 再调无害。用户不存在抛 UserNotFoundError。
  async disableUser(userId: string): Promise<User> {
    return this.requireUser(userId, await this.repository.setUserStatus(userId, "disabled"));
  }

  // 解禁是唯一能把 disabled 用户改回 active 的入口；登录 ensure 不会自动解禁。
  async enableUser(userId: string): Promise<User> {
    return this.requireUser(userId, await this.repository.setUserStatus(userId, "active"));
  }

  async listTeamsForUser(userId: string): Promise<TeamSummary[]> {
    return this.repository.listTeamsForUser(userId);
  }

  private requireUser(userId: string, user: User | null): User {
    if (!user) {
      throw new UserNotFoundError(userId);
    }
    return user;
  }
}
