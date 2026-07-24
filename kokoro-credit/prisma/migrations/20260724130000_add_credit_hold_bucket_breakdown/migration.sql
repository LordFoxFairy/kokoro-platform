-- B1 三桶消费机制：hold 预留明细（按桶）+ 账户时间桶当期额度。
-- reserved*：hold 时从各桶按序（过期先扣）扣走的量，三者之和=amountMicros；settle/release 据此夹紧归还。
-- *AllowanceMicros：时间桶当期额度（懒刷新重置目标 + 归还夹紧上限）；L3.2 Plan 填，现恒 0。
ALTER TABLE `credit_holds`
  ADD COLUMN `reservedDailyMicros` BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN `reservedPeriodMicros` BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN `reservedPermanentMicros` BIGINT NOT NULL DEFAULT 0;

ALTER TABLE `credit_accounts`
  ADD COLUMN `dailyAllowanceMicros` BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN `periodAllowanceMicros` BIGINT NOT NULL DEFAULT 0;

-- 回填：迁移前的存量 active hold 在旧模型下全部从永久桶（balanceMicros）预留，
-- 记 reservedPermanent=amount，使 B1 归还差额（reserved-spent）不为负、语义一致。
UPDATE `credit_holds` SET `reservedPermanentMicros` = `amountMicros` WHERE `status` = 'active';
