export class UserNotFoundError extends Error {
  constructor(public readonly userId: string) {
    super(`user not found: ${userId}`);
    this.name = "UserNotFoundError";
  }
}
