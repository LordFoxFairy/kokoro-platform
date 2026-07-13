-- 订阅写路径幂等键：(provider, providerSubscriptionId) 唯一。
-- 两列均可空（历史行/未绑定网关订阅），MySQL 唯一索引允许多个 NULL，不阻断既有数据。
CREATE UNIQUE INDEX `payment_subscriptions_provider_providerSubscriptionId_key`
    ON `payment_subscriptions`(`provider`, `providerSubscriptionId`);
