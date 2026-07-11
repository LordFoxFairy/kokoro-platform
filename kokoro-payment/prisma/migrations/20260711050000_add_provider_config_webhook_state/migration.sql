-- AlterTable
ALTER TABLE `payment_events` ADD COLUMN `lastError` TEXT NULL;

-- CreateTable
CREATE TABLE `payment_providers` (
    `id` VARCHAR(191) NOT NULL,
    `key` VARCHAR(191) NOT NULL,
    `kind` ENUM('stripe', 'alipay', 'wechat', 'mock') NOT NULL,
    `webhookSecretRef` VARCHAR(191) NOT NULL,
    `enabled` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `payment_providers_key_key`(`key`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `payment_events_status_idx` ON `payment_events`(`status`);
