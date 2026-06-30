-- operator 租户作用域：["*"]=超级跨租户，否则限定 siteId 列表。
ALTER TABLE `operator_accounts` ADD COLUMN `scopeSites` JSON NULL;
UPDATE `operator_accounts` SET `scopeSites` = JSON_ARRAY('*') WHERE `scopeSites` IS NULL;
ALTER TABLE `operator_accounts` MODIFY COLUMN `scopeSites` JSON NOT NULL;
