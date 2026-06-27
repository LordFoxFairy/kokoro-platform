import { parsePositiveBigIntString } from "@kokoro/platform-kit";
import type {
  CreateOrderInput,
  PaymentRepository,
  RecordPaymentEventInput,
  UpsertPlanInput,
} from "../domain/repository.js";

export class PaymentService {
  constructor(private readonly repository: PaymentRepository) {}

  async upsertPlan(input: UpsertPlanInput) {
    parsePositiveBigIntString(input.amountMinor, "amountMinor");
    return this.repository.upsertPlan(input);
  }

  async createOrder(input: CreateOrderInput) {
    parsePositiveBigIntString(input.amountMinor, "amountMinor");
    return this.repository.createOrder(input);
  }

  async recordPaymentEvent(input: RecordPaymentEventInput) {
    return this.repository.recordPaymentEvent(input);
  }
}
