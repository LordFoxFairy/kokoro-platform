import { parsePositiveBigIntString } from "@kokoro/platform-kit";
import type {
  CreditAmountInput,
  CreditRepository,
  EnsureCreditAccountInput,
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
}
