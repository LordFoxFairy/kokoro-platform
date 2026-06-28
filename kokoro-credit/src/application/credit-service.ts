import { parsePositiveBigIntString } from "@kokoro/platform-kit";
import type {
  CaptureCreditInput,
  CreditAmountInput,
  CreditRepository,
  EnsureCreditAccountInput,
  HoldCreditInput,
  QuoteInput,
  ReleaseCreditInput,
} from "../domain/repository.js";

export interface QuoteCommand {
  featureKey: string;
  labelKey?: string | undefined;
  quantity?: string | undefined;
}

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

  async quote(command: QuoteCommand) {
    const quantity = command.quantity ?? "1";
    parsePositiveBigIntString(quantity, "quantity");
    const input: QuoteInput = {
      featureKey: command.featureKey,
      labelKey: command.labelKey,
      quantity,
    };
    return this.repository.quote(input);
  }
}
