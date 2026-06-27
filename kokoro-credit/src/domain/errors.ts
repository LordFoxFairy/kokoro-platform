export class CreditAccountNotFoundError extends Error {
  constructor(accountId: string) {
    super(`Credit account not found: ${accountId}`);
    this.name = "CreditAccountNotFoundError";
  }
}

export class InsufficientCreditError extends Error {
  constructor(accountId: string) {
    super(`Insufficient credit balance: ${accountId}`);
    this.name = "InsufficientCreditError";
  }
}
