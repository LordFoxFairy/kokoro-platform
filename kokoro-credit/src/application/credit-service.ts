import { parsePositiveBigIntString } from "@kokoro/platform-kit";
import type {
  CaptureCreditInput,
  CreditAmountInput,
  CreditRepository,
  EnsureCreditAccountInput,
  HoldCreditInput,
  ReleaseCreditInput,
} from "../domain/repository.js";

export class CreditService {
  constructor(private readonly repository: CreditRepository) {}

  async ensureAccount(input: EnsureCreditAccountInput) {
    return this.repository.ensureAccount(input);
  }

  async grantCredits(input: CreditAmountInput) {
    parsePositiveBigIntString(input.amountMicros, "amountMicros");
    return this.repository.grantCredits(input);
  }

  async spendCredits(input: CreditAmountInput) {
    parsePositiveBigIntString(input.amountMicros, "amountMicros");
    return this.repository.spendCredits(input);
  }

  async holdCredits(input: HoldCreditInput) {
    parsePositiveBigIntString(input.amountMicros, "amountMicros");
    return this.repository.holdCredits(input);
  }

  async captureHold(input: CaptureCreditInput) {
    parsePositiveBigIntString(input.actualAmountMicros, "actualAmountMicros");
    return this.repository.captureHold(input);
  }

  async releaseHold(input: ReleaseCreditInput) {
    return this.repository.releaseHold(input);
  }
}
