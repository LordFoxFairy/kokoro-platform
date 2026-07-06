-- Plan is an operator-managed sellable configuration and can leave default business flows.
-- Orders, subscriptions, payment events, and refunds remain append-only/status facts.
ALTER TABLE `payment_plans`
  ADD COLUMN `deletedAt` DATETIME(3) NULL,
  ADD COLUMN `deletedBy` VARCHAR(191) NULL,
  ADD COLUMN `deleteReason` VARCHAR(191) NULL;

CREATE INDEX `payment_plans_siteId_status_deletedAt_idx`
  ON `payment_plans`(`siteId`, `status`, `deletedAt`);

CREATE INDEX `payment_plans_deletedAt_idx`
  ON `payment_plans`(`deletedAt`);
