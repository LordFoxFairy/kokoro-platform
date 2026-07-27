-- AlterTable
ALTER TABLE `auth_events`
    ADD COLUMN `occurredAt` DATETIME(3) NULL;

UPDATE `auth_events`
SET `occurredAt` = `createdAt`
WHERE `occurredAt` IS NULL;

ALTER TABLE `auth_events`
    MODIFY COLUMN `occurredAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);

-- CreateTable
CREATE TABLE `admin_auth_command_receipts` (
    `commandId` VARCHAR(191) NOT NULL,
    `idempotencyKey` VARCHAR(191) NOT NULL,
    `requestDigest` VARCHAR(191) NOT NULL,
    `operation` VARCHAR(191) NOT NULL,
    `state` ENUM('accepted', 'committed', 'rejected', 'outcome_unknown') NOT NULL DEFAULT 'accepted',
    `result` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `admin_auth_command_receipts_idempotencyKey_key`(`idempotencyKey`),
    INDEX `admin_auth_command_receipts_updatedAt_idx`(`updatedAt`),
    PRIMARY KEY (`commandId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
