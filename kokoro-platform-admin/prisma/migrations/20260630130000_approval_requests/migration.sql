-- CreateTable
CREATE TABLE `approval_requests` (
    `id` VARCHAR(191) NOT NULL,
    `status` ENUM('pending', 'approved', 'rejected', 'executed', 'failed') NOT NULL DEFAULT 'pending',
    `moduleId` VARCHAR(191) NOT NULL,
    `resourceId` VARCHAR(191) NOT NULL,
    `actionId` VARCHAR(191) NOT NULL,
    `params` JSON NULL,
    `body` JSON NULL,
    `siteId` VARCHAR(191) NULL,
    `reason` VARCHAR(191) NULL,
    `requiredPermission` VARCHAR(191) NOT NULL,
    `executionKey` VARCHAR(191) NOT NULL,
    `requestedById` VARCHAR(191) NOT NULL,
    `requestedByEmail` VARCHAR(191) NOT NULL,
    `decidedById` VARCHAR(191) NULL,
    `decidedByEmail` VARCHAR(191) NULL,
    `decisionNote` VARCHAR(191) NULL,
    `resultStatusCode` INTEGER NULL,
    `error` VARCHAR(191) NULL,
    `requestedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `decidedAt` DATETIME(3) NULL,
    `executedAt` DATETIME(3) NULL,

    INDEX `approval_requests_status_requestedAt_idx`(`status`, `requestedAt`),
    INDEX `approval_requests_siteId_idx`(`siteId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

