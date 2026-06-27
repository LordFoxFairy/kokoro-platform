-- CreateTable
CREATE TABLE `credit_accounts` (
    `id` VARCHAR(191) NOT NULL,
    `ownerKind` ENUM('user', 'team') NOT NULL,
    `ownerId` VARCHAR(191) NOT NULL,
    `status` ENUM('active', 'disabled') NOT NULL DEFAULT 'active',
    `balanceMicros` BIGINT NOT NULL DEFAULT 0,
    `heldMicros` BIGINT NOT NULL DEFAULT 0,
    `metadata` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `credit_accounts_status_idx`(`status`),
    UNIQUE INDEX `credit_accounts_ownerKind_ownerId_key`(`ownerKind`, `ownerId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `credit_ledger_entries` (
    `id` VARCHAR(191) NOT NULL,
    `accountId` VARCHAR(191) NOT NULL,
    `amountMicros` BIGINT NOT NULL,
    `balanceAfterMicros` BIGINT NOT NULL,
    `reason` ENUM('manual_adjustment', 'subscription', 'model_call', 'tool_call', 'refund') NOT NULL,
    `idempotencyKey` VARCHAR(191) NOT NULL,
    `requestId` VARCHAR(191) NULL,
    `metadata` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `credit_ledger_entries_idempotencyKey_key`(`idempotencyKey`),
    INDEX `credit_ledger_entries_accountId_createdAt_idx`(`accountId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `credit_holds` (
    `id` VARCHAR(191) NOT NULL,
    `accountId` VARCHAR(191) NOT NULL,
    `amountMicros` BIGINT NOT NULL,
    `status` ENUM('active', 'captured', 'released', 'expired') NOT NULL DEFAULT 'active',
    `idempotencyKey` VARCHAR(191) NOT NULL,
    `expiresAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `credit_holds_idempotencyKey_key`(`idempotencyKey`),
    INDEX `credit_holds_accountId_status_idx`(`accountId`, `status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `credit_usage_records` (
    `id` VARCHAR(191) NOT NULL,
    `accountId` VARCHAR(191) NULL,
    `featureKey` VARCHAR(191) NOT NULL,
    `amountMicros` BIGINT NOT NULL,
    `modelBindingId` VARCHAR(191) NULL,
    `requestId` VARCHAR(191) NULL,
    `idempotencyKey` VARCHAR(191) NULL,
    `status` ENUM('recorded', 'settled', 'failed') NOT NULL DEFAULT 'recorded',
    `metadata` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `credit_usage_records_idempotencyKey_key`(`idempotencyKey`),
    INDEX `credit_usage_records_featureKey_createdAt_idx`(`featureKey`, `createdAt`),
    INDEX `credit_usage_records_accountId_createdAt_idx`(`accountId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `credit_pricing_rules` (
    `id` VARCHAR(191) NOT NULL,
    `featureKey` VARCHAR(191) NOT NULL,
    `labelKey` VARCHAR(191) NULL,
    `unit` VARCHAR(191) NOT NULL,
    `amountMicros` BIGINT NOT NULL,
    `status` ENUM('active', 'disabled') NOT NULL DEFAULT 'active',
    `effectiveFrom` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `effectiveUntil` DATETIME(3) NULL,
    `metadata` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `credit_pricing_rules_featureKey_status_idx`(`featureKey`, `status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `credit_ledger_entries` ADD CONSTRAINT `credit_ledger_entries_accountId_fkey` FOREIGN KEY (`accountId`) REFERENCES `credit_accounts`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `credit_holds` ADD CONSTRAINT `credit_holds_accountId_fkey` FOREIGN KEY (`accountId`) REFERENCES `credit_accounts`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `credit_usage_records` ADD CONSTRAINT `credit_usage_records_accountId_fkey` FOREIGN KEY (`accountId`) REFERENCES `credit_accounts`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
