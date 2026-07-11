-- 确认意图落库(outbox 最小型):confirming=支付已核实、发放/标记未收尾;sweep 只补此态。
-- 纯扩展:existing 行不受影响;回滚=从枚举移除该值(需先确认无行处于该态)。
ALTER TABLE `payment_orders` MODIFY `status` ENUM('pending', 'confirming', 'paid', 'canceled', 'refunded') NOT NULL DEFAULT 'pending';
