export class RedemptionInputError extends Error {
  constructor() {
    super("REDEMPTION_INPUT_INVALID");
    this.name = "RedemptionInputError";
  }
}
