-- siteId 站内隔离：先带默认回填存量行，再去默认强制应用层显式赋值。
ALTER TABLE `users` ADD COLUMN `siteId` VARCHAR(191) NOT NULL DEFAULT 'default';
ALTER TABLE `users` ALTER COLUMN `siteId` DROP DEFAULT;
ALTER TABLE `teams` ADD COLUMN `siteId` VARCHAR(191) NOT NULL DEFAULT 'default';
ALTER TABLE `teams` ALTER COLUMN `siteId` DROP DEFAULT;

-- 全局唯一 → 站内复合唯一。
DROP INDEX `users_externalUserId_key` ON `users`;
DROP INDEX `users_status_idx` ON `users`;
CREATE UNIQUE INDEX `users_siteId_externalUserId_key` ON `users`(`siteId`, `externalUserId`);
CREATE INDEX `users_siteId_status_idx` ON `users`(`siteId`, `status`);

DROP INDEX `teams_slug_key` ON `teams`;
DROP INDEX `teams_status_idx` ON `teams`;
CREATE UNIQUE INDEX `teams_siteId_slug_key` ON `teams`(`siteId`, `slug`);
CREATE INDEX `teams_siteId_status_idx` ON `teams`(`siteId`, `status`);
