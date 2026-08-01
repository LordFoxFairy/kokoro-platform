ALTER TABLE platform.credit_grant
  ADD COLUMN acquired_at TIMESTAMPTZ NOT NULL;

DROP INDEX platform.credit_grant_spend_order_idx;
CREATE INDEX credit_grant_spend_order_idx ON platform.credit_grant(
  credit_account_ref,
  (CASE ux_bucket_class WHEN 'daily' THEN 1 WHEN 'period' THEN 2 ELSE 3 END),
  expires_at ASC NULLS LAST,
  burn_priority ASC,
  acquired_at ASC,
  credit_grant_id ASC
);
