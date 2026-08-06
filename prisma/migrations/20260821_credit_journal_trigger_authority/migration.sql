-- Commit-time Credit integrity checks span facts that runtime writers do not
-- otherwise read. They remain trigger-only and execute under the migration owner.
ALTER FUNCTION platform.assert_credit_journal_transaction_balanced() SECURITY DEFINER;
ALTER FUNCTION platform.assert_credit_journal_transaction_balanced() SET search_path TO pg_catalog, platform;
REVOKE ALL ON FUNCTION platform.assert_credit_journal_transaction_balanced() FROM PUBLIC;

ALTER FUNCTION platform.assert_credit_journal_cross_fact_conservation() SECURITY DEFINER;
ALTER FUNCTION platform.assert_credit_journal_cross_fact_conservation() SET search_path TO pg_catalog, platform;
REVOKE ALL ON FUNCTION platform.assert_credit_journal_cross_fact_conservation() FROM PUBLIC;

ALTER FUNCTION platform.assert_credit_budget_allocation_conservation() SECURITY DEFINER;
ALTER FUNCTION platform.assert_credit_budget_allocation_conservation() SET search_path TO pg_catalog, platform;
REVOKE ALL ON FUNCTION platform.assert_credit_budget_allocation_conservation() FROM PUBLIC;

ALTER FUNCTION platform.assert_credit_allocation_origin_and_root() SECURITY DEFINER;
ALTER FUNCTION platform.assert_credit_allocation_origin_and_root() SET search_path TO pg_catalog, platform;
REVOKE ALL ON FUNCTION platform.assert_credit_allocation_origin_and_root() FROM PUBLIC;

ALTER FUNCTION platform.assert_credit_allocation_receipt_conservation() SECURITY DEFINER;
ALTER FUNCTION platform.assert_credit_allocation_receipt_conservation() SET search_path TO pg_catalog, platform;
REVOKE ALL ON FUNCTION platform.assert_credit_allocation_receipt_conservation() FROM PUBLIC;

ALTER FUNCTION platform.assert_credit_hold_fully_allocated() SECURITY DEFINER;
ALTER FUNCTION platform.assert_credit_hold_fully_allocated() SET search_path TO pg_catalog, platform;
REVOKE ALL ON FUNCTION platform.assert_credit_hold_fully_allocated() FROM PUBLIC;

ALTER FUNCTION platform.assert_credit_hold_terminal_segments_closed() SECURITY DEFINER;
ALTER FUNCTION platform.assert_credit_hold_terminal_segments_closed() SET search_path TO pg_catalog, platform;
REVOKE ALL ON FUNCTION platform.assert_credit_hold_terminal_segments_closed() FROM PUBLIC;

ALTER FUNCTION platform.assert_credit_authorization_segment_capacity() SECURITY DEFINER;
ALTER FUNCTION platform.assert_credit_authorization_segment_capacity() SET search_path TO pg_catalog, platform;
REVOKE ALL ON FUNCTION platform.assert_credit_authorization_segment_capacity() FROM PUBLIC;
