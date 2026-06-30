-- siteId 站内隔离：先带默认回填存量行，再去默认强制应用层显式赋值。
ALTER TABLE `credit_accounts` ADD COLUMN `siteId` VARCHAR(191) NOT NULL DEFAULT 'default';
ALTER TABLE `credit_accounts` ALTER COLUMN `siteId` DROP DEFAULT;

-- (ownerKind, ownerId) 全局唯一 → (siteId, ownerKind, ownerId) 站内唯一。
DROP INDEX `credit_accounts_ownerKind_ownerId_key` ON `credit_accounts`;
DROP INDEX `credit_accounts_status_idx` ON `credit_accounts`;
CREATE UNIQUE INDEX `credit_accounts_siteId_ownerKind_ownerId_key` ON `credit_accounts`(`siteId`, `ownerKind`, `ownerId`);
CREATE INDEX `credit_accounts_siteId_status_idx` ON `credit_accounts`(`siteId`, `status`);
