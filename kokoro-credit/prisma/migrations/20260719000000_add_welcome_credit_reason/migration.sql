-- welcome 授信入账原因（新用户首次开通送积分）：CreditReason enum 增值 welcome。
-- 纯扩展：MySQL enum 追加值不改存量行，向前兼容。
ALTER TABLE `credit_ledger_entries`
  MODIFY `reason` ENUM('manual_adjustment', 'subscription', 'model_call', 'tool_call', 'refund', 'welcome') NOT NULL;
