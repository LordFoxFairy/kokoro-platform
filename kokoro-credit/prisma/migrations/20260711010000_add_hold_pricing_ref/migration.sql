-- 用量结算面：在 hold 上记录 pricing_ref 与归属，settle 仅凭 holdId + usage 复算实额。
-- 全部可空、无默认，纯扩展；存量 hold 行不受影响（raw hold 路径继续留空）。
ALTER TABLE `credit_holds`
  ADD COLUMN `featureKey` VARCHAR(191) NULL,
  ADD COLUMN `labelKey` VARCHAR(191) NULL,
  ADD COLUMN `modelBindingId` VARCHAR(191) NULL,
  ADD COLUMN `requestId` VARCHAR(191) NULL;
