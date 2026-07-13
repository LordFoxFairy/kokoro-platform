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

// 组织级配额超限：与余额不足（InsufficientCreditError）区分——余额够但本周期消费上限已满。
// 路由映射为 402 credit.quota_exceeded（专用码，session 透传，web ERROR-UX 文案后补）。
export class QuotaExceededError extends Error {
  constructor(accountId: string) {
    super(`Credit quota exceeded for period: ${accountId}`);
    this.name = "QuotaExceededError";
  }
}

export class CreditHoldNotFoundError extends Error {
  constructor(holdId: string) {
    super(`Credit hold not found: ${holdId}`);
    this.name = "CreditHoldNotFoundError";
  }
}

export class CreditCaptureExceedsHoldError extends Error {
  constructor(holdId: string) {
    super(`Capture amount exceeds hold: ${holdId}`);
    this.name = "CreditCaptureExceedsHoldError";
  }
}

export class CreditHoldNotActiveError extends Error {
  constructor(holdId: string, status: string) {
    super(`Credit hold is not active (${status}): ${holdId}`);
    this.name = "CreditHoldNotActiveError";
  }
}

export class PricingRuleNotFoundError extends Error {
  constructor(featureKey: string) {
    super(`Pricing rule not found: ${featureKey}`);
    this.name = "PricingRuleNotFoundError";
  }
}
