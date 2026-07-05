-- Credit lifecycle fields apply only to business resources. Ledger, usage,
-- and holds remain append-only / state-machine records.
ALTER TABLE `credit_accounts`
    ADD COLUMN `deletedAt` DATETIME(3) NULL,
    ADD COLUMN `deletedBy` VARCHAR(191) NULL,
    ADD COLUMN `deleteReason` VARCHAR(191) NULL;

ALTER TABLE `credit_pricing_rules`
    ADD COLUMN `deletedAt` DATETIME(3) NULL,
    ADD COLUMN `deletedBy` VARCHAR(191) NULL,
    ADD COLUMN `deleteReason` VARCHAR(191) NULL;

CREATE INDEX `credit_accounts_siteId_status_deletedAt_idx` ON `credit_accounts`(`siteId`, `status`, `deletedAt`);
CREATE INDEX `credit_accounts_deletedAt_idx` ON `credit_accounts`(`deletedAt`);

CREATE INDEX `credit_pricing_rules_featureKey_status_deletedAt_idx` ON `credit_pricing_rules`(`featureKey`, `status`, `deletedAt`);
CREATE INDEX `credit_pricing_rules_deletedAt_idx` ON `credit_pricing_rules`(`deletedAt`);
