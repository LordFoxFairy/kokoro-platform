-- Pure additive: magic-link one-time login tokens. Only the SHA-256 hash of the
-- token is persisted (never the raw token). New links for the same (siteId, email)
-- supersede unconsumed older links via `supersededAt`.
CREATE TABLE `magic_links` (
    `id` VARCHAR(191) NOT NULL,
    `siteId` VARCHAR(191) NOT NULL,
    `email` VARCHAR(191) NOT NULL,
    `tokenHash` VARCHAR(191) NOT NULL,
    `expiresAt` DATETIME(3) NOT NULL,
    `consumedAt` DATETIME(3) NULL,
    `supersededAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `magic_links_tokenHash_key`(`tokenHash`),
    INDEX `magic_links_siteId_email_consumedAt_supersededAt_idx`(`siteId`, `email`, `consumedAt`, `supersededAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
