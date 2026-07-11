-- 过期回收 sweep 的驱动查询走 status='active' AND expiresAt < now，加复合索引避免全表扫描。
-- 纯扩展、无数据变更；存量行不受影响。
CREATE INDEX `credit_holds_status_expiresAt_idx` ON `credit_holds`(`status`, `expiresAt`);
