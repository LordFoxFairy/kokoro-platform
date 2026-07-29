export type CommerceApplicationErrorCode = "REDEEM_NOT_ACCEPTED" | "REDEEM_TEMPORARILY_UNAVAILABLE";

export class CommerceApplicationError extends Error {
  constructor(readonly code: CommerceApplicationErrorCode) {
    super(code);
    this.name = "CommerceApplicationError";
  }
}
