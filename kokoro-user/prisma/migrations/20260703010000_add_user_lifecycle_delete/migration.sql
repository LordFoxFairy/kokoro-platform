-- Add nullable lifecycle audit fields. Business delete remains a soft delete;
-- hard delete stays limited to local test/database reset workflows.
ALTER TABLE `users`
    ADD COLUMN `deletedAt` DATETIME(3) NULL,
    ADD COLUMN `deletedBy` VARCHAR(191) NULL,
    ADD COLUMN `deleteReason` VARCHAR(191) NULL;

ALTER TABLE `teams`
    ADD COLUMN `deletedAt` DATETIME(3) NULL,
    ADD COLUMN `deletedBy` VARCHAR(191) NULL,
    ADD COLUMN `deleteReason` VARCHAR(191) NULL;

ALTER TABLE `memberships`
    ADD COLUMN `deletedAt` DATETIME(3) NULL,
    ADD COLUMN `deletedBy` VARCHAR(191) NULL,
    ADD COLUMN `deleteReason` VARCHAR(191) NULL;

ALTER TABLE `roles`
    ADD COLUMN `deletedAt` DATETIME(3) NULL,
    ADD COLUMN `deletedBy` VARCHAR(191) NULL,
    ADD COLUMN `deleteReason` VARCHAR(191) NULL;

ALTER TABLE `invites`
    ADD COLUMN `deletedAt` DATETIME(3) NULL,
    ADD COLUMN `deletedBy` VARCHAR(191) NULL,
    ADD COLUMN `deleteReason` VARCHAR(191) NULL;

ALTER TABLE `service_accounts`
    ADD COLUMN `deletedAt` DATETIME(3) NULL,
    ADD COLUMN `deletedBy` VARCHAR(191) NULL,
    ADD COLUMN `deleteReason` VARCHAR(191) NULL;

-- Upgrade read-path indexes so default queries can filter deleted rows without
-- changing the identity uniqueness contract.
CREATE INDEX `users_siteId_status_deletedAt_idx` ON `users`(`siteId`, `status`, `deletedAt`);
CREATE INDEX `users_deletedAt_idx` ON `users`(`deletedAt`);

CREATE INDEX `teams_siteId_status_deletedAt_idx` ON `teams`(`siteId`, `status`, `deletedAt`);
CREATE INDEX `teams_deletedAt_idx` ON `teams`(`deletedAt`);

CREATE INDEX `memberships_teamId_status_deletedAt_idx` ON `memberships`(`teamId`, `status`, `deletedAt`);
CREATE INDEX `memberships_userId_status_deletedAt_idx` ON `memberships`(`userId`, `status`, `deletedAt`);
CREATE INDEX `memberships_deletedAt_idx` ON `memberships`(`deletedAt`);
DROP INDEX `memberships_userId_status_idx` ON `memberships`;

CREATE INDEX `roles_teamId_status_deletedAt_idx` ON `roles`(`teamId`, `status`, `deletedAt`);
CREATE INDEX `roles_deletedAt_idx` ON `roles`(`deletedAt`);
DROP INDEX `roles_teamId_idx` ON `roles`;

CREATE INDEX `invites_teamId_status_deletedAt_idx` ON `invites`(`teamId`, `status`, `deletedAt`);
CREATE INDEX `invites_deletedAt_idx` ON `invites`(`deletedAt`);
DROP INDEX `invites_teamId_status_idx` ON `invites`;

CREATE INDEX `service_accounts_teamId_status_deletedAt_idx` ON `service_accounts`(`teamId`, `status`, `deletedAt`);
CREATE INDEX `service_accounts_ownerUserId_status_deletedAt_idx` ON `service_accounts`(`ownerUserId`, `status`, `deletedAt`);
CREATE INDEX `service_accounts_deletedAt_idx` ON `service_accounts`(`deletedAt`);
DROP INDEX `service_accounts_teamId_status_idx` ON `service_accounts`;
