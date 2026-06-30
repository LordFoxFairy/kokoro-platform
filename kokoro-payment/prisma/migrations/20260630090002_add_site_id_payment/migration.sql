-- siteId 站内隔离：先带默认回填存量行，再去默认强制应用层显式赋值。
ALTER TABLE `payment_plans` ADD COLUMN `siteId` VARCHAR(191) NOT NULL DEFAULT 'default';
ALTER TABLE `payment_plans` ALTER COLUMN `siteId` DROP DEFAULT;
ALTER TABLE `payment_orders` ADD COLUMN `siteId` VARCHAR(191) NOT NULL DEFAULT 'default';
ALTER TABLE `payment_orders` ALTER COLUMN `siteId` DROP DEFAULT;

-- Plan.key 全局唯一 → (siteId, key) 站内唯一。
DROP INDEX `payment_plans_key_key` ON `payment_plans`;
DROP INDEX `payment_plans_status_idx` ON `payment_plans`;
CREATE UNIQUE INDEX `payment_plans_siteId_key_key` ON `payment_plans`(`siteId`, `key`);
CREATE INDEX `payment_plans_siteId_status_idx` ON `payment_plans`(`siteId`, `status`);

-- Order 站内查询索引。
DROP INDEX `payment_orders_teamId_status_idx` ON `payment_orders`;
CREATE INDEX `payment_orders_siteId_teamId_status_idx` ON `payment_orders`(`siteId`, `teamId`, `status`);
