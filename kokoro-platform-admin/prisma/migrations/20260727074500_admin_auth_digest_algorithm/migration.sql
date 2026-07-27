-- AlterTable
ALTER TABLE `admin_auth_command_receipts`
    ADD COLUMN `digestAlgorithm` ENUM('sha256_protobuf_v1') NOT NULL DEFAULT 'sha256_protobuf_v1' AFTER `idempotencyKey`;
