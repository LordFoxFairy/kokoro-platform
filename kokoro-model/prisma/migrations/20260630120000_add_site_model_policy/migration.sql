-- CreateTable
CREATE TABLE `model_site_policies` (
    `id` VARCHAR(191) NOT NULL,
    `siteId` VARCHAR(191) NOT NULL,
    `labelKey` VARCHAR(191) NOT NULL,
    `status` ENUM('visible', 'hidden') NOT NULL DEFAULT 'visible',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `model_site_policies_siteId_idx`(`siteId`),
    UNIQUE INDEX `model_site_policies_siteId_labelKey_key`(`siteId`, `labelKey`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

