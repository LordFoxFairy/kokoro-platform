SET statement_timeout = '30s';
SET lock_timeout = '5s';
SET idle_in_transaction_session_timeout = '30s';

-- The authorization runtime may freeze the global owner watermark for a snapshot,
-- but it must not receive UPDATE authority on the owner cursor solely to acquire a row lock.
CREATE FUNCTION platform.lock_authorization_snapshot_watermark()
RETURNS BIGINT
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER SET search_path=pg_catalog,platform
AS $function$
DECLARE
  locked_watermark BIGINT;
BEGIN
  IF current_setting('app.workload_kind',true)<>'platform_authorization'
     OR current_setting('app.operation',true)<>'authorization.snapshot.create' THEN
    RAISE EXCEPTION 'AUTHORIZATION_SNAPSHOT_LOCK_AUTHORITY_INVALID' USING ERRCODE='42501';
  END IF;

  SELECT high_watermark INTO STRICT locked_watermark
  FROM platform.authorization_scoped_stream_state
  WHERE singleton=TRUE
  FOR SHARE;
  RETURN locked_watermark;
END
$function$;

REVOKE ALL ON FUNCTION platform.lock_authorization_snapshot_watermark() FROM PUBLIC;
