-- 三桶（L3.1）：账户在永久桶（balanceMicros，积分包/欢迎，不过期）之外，增两类时间型桶。
-- dailyMicros/periodMicros=每日/周期赠额（懒刷新，use-or-lose）；*ResetOn=各桶水位（NULL=未初始化/无订阅）。
-- 纯扩展：两桶金额 NOT NULL DEFAULT 0（存量账户=0，不改现状消费）；水位可空（懒刷新首次 access 初始化）。
-- allowance 由生效 Plan 供给（L3.2 前恒 0，时间桶恒空），本迁移只加列不改消费机制。
ALTER TABLE `credit_accounts`
  ADD COLUMN `dailyMicros` BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN `dailyResetOn` DATETIME(3) NULL,
  ADD COLUMN `periodMicros` BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN `periodResetOn` DATETIME(3) NULL;
