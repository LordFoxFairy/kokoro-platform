-- CreateTable
CREATE TABLE `site_feature_flags` (
    `id` VARCHAR(191) NOT NULL,
    `siteId` VARCHAR(191) NOT NULL,
    `key` VARCHAR(191) NOT NULL,
    `enabled` BOOLEAN NOT NULL DEFAULT false,
    `metadata` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `site_feature_flags_siteId_idx`(`siteId`),
    UNIQUE INDEX `site_feature_flags_siteId_key_key`(`siteId`, `key`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `site_feature_flags` ADD CONSTRAINT `site_feature_flags_siteId_fkey` FOREIGN KEY (`siteId`) REFERENCES `site_sites`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

