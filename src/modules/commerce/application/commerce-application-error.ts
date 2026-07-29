export type CommerceApplicationErrorCode =
  | "REDEEM_NOT_ACCEPTED"
  | "REDEEM_TEMPORARILY_UNAVAILABLE"
  | "REDEMPTION_NOT_FOUND"
  | "ACCOUNT_RESOURCE_NOT_FOUND";

export class CommerceApplicationError extends Error {
  constructor(readonly code: CommerceApplicationErrorCode) {
    super(code);
    this.name = "CommerceApplicationError";
  }
}
