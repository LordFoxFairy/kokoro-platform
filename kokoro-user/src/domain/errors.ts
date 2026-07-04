export class UserNotFoundError extends Error {
  constructor(public readonly userId: string) {
    super(`user not found: ${userId}`);
    this.name = "UserNotFoundError";
  }
}

export class TeamNotFoundError extends Error {
  constructor(public readonly teamId: string) {
    super(`team not found: ${teamId}`);
    this.name = "TeamNotFoundError";
  }
}
