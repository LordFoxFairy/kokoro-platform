-- SITE-REAL: domain ownership verification + minimal brand face for host resolve.
-- Additive nullable columns only; existing rows keep resolving (status=active == verified).

ALTER TABLE `site_sites`
  ADD COLUMN `brandLogoUrl` VARCHAR(191) NULL,
  ADD COLUMN `brandThemeColor` VARCHAR(191) NULL;

ALTER TABLE `site_domains`
  ADD COLUMN `verificationToken` VARCHAR(191) NULL,
  ADD COLUMN `verifiedAt` DATETIME(3) NULL;
