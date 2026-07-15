-- Pure additive: long-lived refresh tokens. Only the SHA-256 hash of the token
-- is persisted (never the raw token). Rotation is a one-time conditional transfer
-- (consumedAt); a replayed already-consumed token revokes the whole namespace's
-- live tokens. Hand-written (no `migrate dev` on the shared DB); applied with
-- `migrate deploy`.
CREATE TABLE `refresh_tokens` (
    `id` VARCHAR(191) NOT NULL,
    `namespace` VARCHAR(191) NOT NULL,
    `siteId` VARCHAR(191) NOT NULL,
    `tokenHash` VARCHAR(191) NOT NULL,
    `tokenPrefix` VARCHAR(191) NOT NULL,
    `expiresAt` DATETIME(3) NOT NULL,
    `consumedAt` DATETIME(3) NULL,
    `revokedAt` DATETIME(3) NULL,
    `replacedById` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `refresh_tokens_tokenHash_key`(`tokenHash`),
    INDEX `refresh_tokens_namespace_revokedAt_idx`(`namespace`, `revokedAt`),
    INDEX `refresh_tokens_expiresAt_idx`(`expiresAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
