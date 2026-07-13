-- 组织级配额（消费上限）：账户增可空 quotaMicros(周期上限，微单位) + quotaPeriod(V1 仅 monthly)。
-- 纯扩展、两列全可空：存量行 quota=NULL=不限（现状行为不变），无数据回填。
-- 周期累计复用既有 credit_ledger_entries(accountId, createdAt) 索引聚合，不建新表。
ALTER TABLE `credit_accounts`
  ADD COLUMN `quotaMicros` BIGINT NULL,
  ADD COLUMN `quotaPeriod` ENUM('monthly') NULL;
