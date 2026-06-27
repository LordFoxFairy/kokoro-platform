-- CreateTable
CREATE TABLE `model_provider_accounts` (
    `id` VARCHAR(191) NOT NULL,
    `provider` VARCHAR(191) NOT NULL,
    `key` VARCHAR(191) NOT NULL,
    `label` VARCHAR(191) NOT NULL,
    `secretRef` VARCHAR(191) NOT NULL,
    `status` ENUM('active', 'disabled') NOT NULL DEFAULT 'active',
    `priority` INTEGER NOT NULL DEFAULT 100,
    `transportKind` ENUM('litellm', 'direct', 'internal') NOT NULL,
    `healthStatus` ENUM('unknown', 'healthy', 'degraded', 'down') NOT NULL DEFAULT 'unknown',
    `metadata` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `model_provider_accounts_status_priority_idx`(`status`, `priority`),
    UNIQUE INDEX `model_provider_accounts_provider_key_key`(`provider`, `key`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `model_bindings` (
    `id` VARCHAR(191) NOT NULL,
    `providerAccountId` VARCHAR(191) NOT NULL,
    `provider` VARCHAR(191) NOT NULL,
    `modelName` VARCHAR(191) NOT NULL,
    `displayName` VARCHAR(191) NOT NULL,
    `featureKey` VARCHAR(191) NOT NULL,
    `labelKeys` JSON NOT NULL,
    `inputModalities` JSON NOT NULL,
    `outputModalities` JSON NOT NULL,
    `transportKind` ENUM('litellm', 'direct', 'internal') NOT NULL,
    `gatewayModelName` VARCHAR(191) NULL,
    `contextWindow` INTEGER NULL,
    `priority` INTEGER NOT NULL DEFAULT 100,
    `status` ENUM('active', 'disabled') NOT NULL DEFAULT 'active',
    `metadata` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `model_bindings_featureKey_status_priority_idx`(`featureKey`, `status`, `priority`),
    INDEX `model_bindings_provider_modelName_idx`(`provider`, `modelName`),
    UNIQUE INDEX `model_bindings_providerAccountId_modelName_transportKind_key`(`providerAccountId`, `modelName`, `transportKind`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `model_labels` (
    `id` VARCHAR(191) NOT NULL,
    `key` VARCHAR(191) NOT NULL,
    `displayName` VARCHAR(191) NOT NULL,
    `description` VARCHAR(191) NULL,
    `featureKey` VARCHAR(191) NOT NULL,
    `tier` VARCHAR(191) NULL,
    `defaultBindingId` VARCHAR(191) NULL,
    `status` ENUM('active', 'disabled') NOT NULL DEFAULT 'active',
    `metadata` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `model_labels_key_key`(`key`),
    INDEX `model_labels_featureKey_status_idx`(`featureKey`, `status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `model_bindings` ADD CONSTRAINT `model_bindings_providerAccountId_fkey` FOREIGN KEY (`providerAccountId`) REFERENCES `model_provider_accounts`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
