-- CreateTable
CREATE TABLE `site_sites` (
    `id` VARCHAR(191) NOT NULL,
    `key` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `status` ENUM('draft', 'sandbox', 'beta', 'active', 'suspended', 'archived') NOT NULL DEFAULT 'draft',
    `defaultLocale` VARCHAR(191) NOT NULL DEFAULT 'zh-CN',
    `timezone` VARCHAR(191) NOT NULL DEFAULT 'Asia/Shanghai',
    `metadata` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `site_sites_key_key`(`key`),
    INDEX `site_sites_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `site_domains` (
    `id` VARCHAR(191) NOT NULL,
    `siteId` VARCHAR(191) NOT NULL,
    `host` VARCHAR(191) NOT NULL,
    `status` ENUM('active', 'disabled', 'pending_verification') NOT NULL DEFAULT 'active',
    `isPrimary` BOOLEAN NOT NULL DEFAULT false,
    `canonicalHost` VARCHAR(191) NULL,
    `metadata` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `site_domains_host_key`(`host`),
    INDEX `site_domains_siteId_status_idx`(`siteId`, `status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `site_apps` (
    `id` VARCHAR(191) NOT NULL,
    `siteId` VARCHAR(191) NOT NULL,
    `appKey` VARCHAR(191) NOT NULL,
    `surface` ENUM('general', 'studio', 'api', 'admin', 'public_seo') NOT NULL,
    `status` ENUM('active', 'disabled') NOT NULL DEFAULT 'active',
    `defaultRoute` VARCHAR(191) NULL,
    `metadata` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `site_apps_siteId_status_idx`(`siteId`, `status`),
    UNIQUE INDEX `site_apps_siteId_appKey_surface_key`(`siteId`, `appKey`, `surface`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `site_policies` (
    `id` VARCHAR(191) NOT NULL,
    `siteId` VARCHAR(191) NOT NULL,
    `key` VARCHAR(191) NOT NULL,
    `value` JSON NOT NULL,
    `status` ENUM('active', 'disabled') NOT NULL DEFAULT 'active',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `site_policies_siteId_status_idx`(`siteId`, `status`),
    UNIQUE INDEX `site_policies_siteId_key_key`(`siteId`, `key`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `site_brand_configs` (
    `id` VARCHAR(191) NOT NULL,
    `siteId` VARCHAR(191) NOT NULL,
    `key` VARCHAR(191) NOT NULL,
    `themeKey` VARCHAR(191) NOT NULL,
    `logoUrl` VARCHAR(191) NULL,
    `copyNamespace` VARCHAR(191) NULL,
    `layoutKey` VARCHAR(191) NULL,
    `status` ENUM('active', 'disabled') NOT NULL DEFAULT 'active',
    `metadata` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `site_brand_configs_siteId_status_idx`(`siteId`, `status`),
    UNIQUE INDEX `site_brand_configs_siteId_key_key`(`siteId`, `key`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `site_seo_configs` (
    `id` VARCHAR(191) NOT NULL,
    `siteId` VARCHAR(191) NOT NULL,
    `routePattern` VARCHAR(191) NOT NULL,
    `titleTemplate` VARCHAR(191) NOT NULL,
    `descriptionTemplate` VARCHAR(191) NULL,
    `canonicalPolicy` VARCHAR(191) NULL,
    `robotsPolicy` VARCHAR(191) NULL,
    `structuredDataKind` VARCHAR(191) NULL,
    `sitemapPriority` DECIMAL(2, 1) NULL,
    `status` ENUM('active', 'disabled') NOT NULL DEFAULT 'active',
    `metadata` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `site_seo_configs_siteId_status_idx`(`siteId`, `status`),
    UNIQUE INDEX `site_seo_configs_siteId_routePattern_key`(`siteId`, `routePattern`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `site_domains` ADD CONSTRAINT `site_domains_siteId_fkey` FOREIGN KEY (`siteId`) REFERENCES `site_sites`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `site_apps` ADD CONSTRAINT `site_apps_siteId_fkey` FOREIGN KEY (`siteId`) REFERENCES `site_sites`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `site_policies` ADD CONSTRAINT `site_policies_siteId_fkey` FOREIGN KEY (`siteId`) REFERENCES `site_sites`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `site_brand_configs` ADD CONSTRAINT `site_brand_configs_siteId_fkey` FOREIGN KEY (`siteId`) REFERENCES `site_sites`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `site_seo_configs` ADD CONSTRAINT `site_seo_configs_siteId_fkey` FOREIGN KEY (`siteId`) REFERENCES `site_sites`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
