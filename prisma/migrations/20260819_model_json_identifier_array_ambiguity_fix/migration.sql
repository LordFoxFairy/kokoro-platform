SET statement_timeout = '30s';
SET lock_timeout = '5s';
SET idle_in_transaction_session_timeout = '30s';

-- Qualify the derived columns so PL/pgSQL does not confuse the `value`
-- function parameter with the sorted item column.
CREATE OR REPLACE FUNCTION platform.model_json_identifier_array_is_canonical(
  value JSONB,
  required BOOLEAN
) RETURNS BOOLEAN LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
BEGIN
  IF jsonb_typeof(value) IS DISTINCT FROM 'array' THEN
    RETURN FALSE;
  END IF;
  IF (required AND jsonb_array_length(value)=0)
     OR EXISTS (
       SELECT 1 FROM jsonb_array_elements(value) item
       WHERE jsonb_typeof(item) IS DISTINCT FROM 'string'
          OR NOT platform.model_identifier_is_valid(item#>>'{}')
     )
     OR EXISTS (
       SELECT 1 FROM (
         SELECT item#>>'{}' AS value,
           lag(item#>>'{}') OVER (ORDER BY ordinal) AS previous
         FROM jsonb_array_elements(value) WITH ORDINALITY element(item,ordinal)
       ) ordered
       WHERE ordered.previous IS NOT NULL
         AND ordered.previous COLLATE "C" >= ordered.value COLLATE "C"
     ) THEN
    RETURN FALSE;
  END IF;
  RETURN TRUE;
END $$;
