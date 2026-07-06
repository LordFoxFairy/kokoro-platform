-- AlterTable
ALTER TABLE `model_provider_accounts`
    ADD COLUMN `deletedAt` DATETIME(3) NULL,
    ADD COLUMN `deletedBy` VARCHAR(191) NULL,
    ADD COLUMN `deleteReason` VARCHAR(191) NULL;

-- AlterTable
ALTER TABLE `model_bindings`
    ADD COLUMN `deletedAt` DATETIME(3) NULL,
    ADD COLUMN `deletedBy` VARCHAR(191) NULL,
    ADD COLUMN `deleteReason` VARCHAR(191) NULL;

-- DropIndex
DROP INDEX `model_bindings_featureKey_status_priority_idx` ON `model_bindings`;

-- CreateIndex
CREATE INDEX `model_bindings_featureKey_status_deletedAt_priority_idx` ON `model_bindings`(`featureKey`, `status`, `deletedAt`, `priority`);
