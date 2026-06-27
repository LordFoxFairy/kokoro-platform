import type {
  EnsureUserInput,
  EnsureUserResult,
  TeamSummary,
  UserRepository,
} from "../domain/repository.js";

export class UserService {
  constructor(private readonly repository: UserRepository) {}

  async ensureUserWithPersonalTeam(input: EnsureUserInput): Promise<EnsureUserResult> {
    return this.repository.ensureUserWithPersonalTeam(input);
  }

  async listTeamsForUser(userId: string): Promise<TeamSummary[]> {
    return this.repository.listTeamsForUser(userId);
  }
}
