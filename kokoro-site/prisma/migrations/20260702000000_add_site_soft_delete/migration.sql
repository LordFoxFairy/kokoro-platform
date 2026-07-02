-- Add soft-delete audit columns to every kokoro-site business table.
-- Unique keys stay unchanged so deleted site keys and hosts remain reserved until explicit restore.

ALTER TABLE `site_sites`
  ADD COLUMN `deletedAt` DATETIME(3) NULL,
  ADD COLUMN `deletedBy` VARCHAR(191) NULL,
  ADD COLUMN `deleteReason` VARCHAR(191) NULL;

CREATE INDEX `site_sites_deletedAt_idx` ON `site_sites`(`deletedAt`);
CREATE INDEX `site_sites_status_deletedAt_idx` ON `site_sites`(`status`, `deletedAt`);

ALTER TABLE `site_domains`
  ADD COLUMN `deletedAt` DATETIME(3) NULL,
  ADD COLUMN `deletedBy` VARCHAR(191) NULL,
  ADD COLUMN `deleteReason` VARCHAR(191) NULL;

CREATE INDEX `site_domains_siteId_status_deletedAt_idx` ON `site_domains`(`siteId`, `status`, `deletedAt`);
CREATE INDEX `site_domains_deletedAt_idx` ON `site_domains`(`deletedAt`);

ALTER TABLE `site_apps`
  ADD COLUMN `deletedAt` DATETIME(3) NULL,
  ADD COLUMN `deletedBy` VARCHAR(191) NULL,
  ADD COLUMN `deleteReason` VARCHAR(191) NULL;

CREATE INDEX `site_apps_siteId_status_deletedAt_idx` ON `site_apps`(`siteId`, `status`, `deletedAt`);
CREATE INDEX `site_apps_deletedAt_idx` ON `site_apps`(`deletedAt`);

ALTER TABLE `site_policies`
  ADD COLUMN `deletedAt` DATETIME(3) NULL,
  ADD COLUMN `deletedBy` VARCHAR(191) NULL,
  ADD COLUMN `deleteReason` VARCHAR(191) NULL;

CREATE INDEX `site_policies_siteId_status_deletedAt_idx` ON `site_policies`(`siteId`, `status`, `deletedAt`);
CREATE INDEX `site_policies_deletedAt_idx` ON `site_policies`(`deletedAt`);

ALTER TABLE `site_brand_configs`
  ADD COLUMN `deletedAt` DATETIME(3) NULL,
  ADD COLUMN `deletedBy` VARCHAR(191) NULL,
  ADD COLUMN `deleteReason` VARCHAR(191) NULL;

CREATE INDEX `site_brand_configs_siteId_status_deletedAt_idx` ON `site_brand_configs`(`siteId`, `status`, `deletedAt`);
CREATE INDEX `site_brand_configs_deletedAt_idx` ON `site_brand_configs`(`deletedAt`);

ALTER TABLE `site_seo_configs`
  ADD COLUMN `deletedAt` DATETIME(3) NULL,
  ADD COLUMN `deletedBy` VARCHAR(191) NULL,
  ADD COLUMN `deleteReason` VARCHAR(191) NULL;

CREATE INDEX `site_seo_configs_siteId_status_deletedAt_idx` ON `site_seo_configs`(`siteId`, `status`, `deletedAt`);
CREATE INDEX `site_seo_configs_deletedAt_idx` ON `site_seo_configs`(`deletedAt`);

ALTER TABLE `site_feature_flags`
  ADD COLUMN `deletedAt` DATETIME(3) NULL,
  ADD COLUMN `deletedBy` VARCHAR(191) NULL,
  ADD COLUMN `deleteReason` VARCHAR(191) NULL;

CREATE INDEX `site_feature_flags_siteId_deletedAt_idx` ON `site_feature_flags`(`siteId`, `deletedAt`);
CREATE INDEX `site_feature_flags_deletedAt_idx` ON `site_feature_flags`(`deletedAt`);
