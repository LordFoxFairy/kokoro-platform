SET statement_timeout = '30s';
SET lock_timeout = '5s';
SET idle_in_transaction_session_timeout = '30s';

ALTER TABLE platform.artifact_delivery_authorization
  ADD COLUMN site_release_ref TEXT NOT NULL,
  ADD COLUMN workload_identity_ref TEXT NOT NULL,
  ADD COLUMN workload_binding_epoch BIGINT NOT NULL CHECK(workload_binding_epoch > 0),
  ADD COLUMN site_security_epoch BIGINT NOT NULL CHECK(site_security_epoch > 0),
  ADD COLUMN suggested_file_name TEXT
    CHECK(length(suggested_file_name) BETWEEN 1 AND 255 AND
      suggested_file_name !~ E'[\\x00-\\x1f\\x7f/\\\\]'),
  ADD COLUMN revocation_reason TEXT
    CHECK(length(revocation_reason) BETWEEN 1 AND 256 AND
      revocation_reason !~ E'[\\x00-\\x1f\\x7f]');
ALTER TABLE platform.artifact_delivery_authorization
  ADD CONSTRAINT artifact_delivery_filename_purpose_check
  CHECK(purpose='download' OR suggested_file_name IS NULL);

CREATE INDEX artifact_delivery_authorization_expiry_idx
  ON platform.artifact_delivery_authorization(expires_at)
  WHERE revoked_at IS NULL;

CREATE TABLE platform.artifact_delivery_redemption_audit (
  redemption_ref TEXT PRIMARY KEY,
  authorization_ref TEXT NOT NULL REFERENCES platform.artifact_delivery_authorization(authorization_ref),
  request_ref TEXT NOT NULL,
  site_ref TEXT NOT NULL REFERENCES platform.site(site_ref),
  site_release_ref TEXT NOT NULL,
  workload_identity_ref TEXT NOT NULL,
  workload_binding_epoch BIGINT NOT NULL CHECK(workload_binding_epoch > 0),
  site_security_epoch BIGINT NOT NULL CHECK(site_security_epoch > 0),
  range_header TEXT CHECK(length(range_header) BETWEEN 1 AND 64),
  state TEXT NOT NULL CHECK(state IN ('pending','stream_completed','failed')),
  attempted_at TIMESTAMPTZ NOT NULL,
  stream_completed_at TIMESTAMPTZ,
  failed_at TIMESTAMPTZ,
  bytes_emitted BIGINT CHECK(bytes_emitted > 0),
  failure_code TEXT CHECK(failure_code IN ('range_rejected','storage_failed','client_aborted')),
  CHECK((state='pending' AND stream_completed_at IS NULL AND failed_at IS NULL AND
         bytes_emitted IS NULL AND failure_code IS NULL) OR
        (state='stream_completed' AND stream_completed_at IS NOT NULL AND failed_at IS NULL AND
         bytes_emitted IS NOT NULL AND failure_code IS NULL) OR
        (state='failed' AND stream_completed_at IS NULL AND failed_at IS NOT NULL AND
         bytes_emitted IS NULL AND failure_code IS NOT NULL))
);
CREATE INDEX artifact_delivery_redemption_pending_idx
  ON platform.artifact_delivery_redemption_audit(attempted_at) WHERE state='pending';

ALTER TABLE platform.artifact_delivery_redemption_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.artifact_delivery_redemption_audit FORCE ROW LEVEL SECURITY;
CREATE POLICY artifact_delivery_data_plane_definer
  ON platform.artifact_delivery_redemption_audit TO platform_migrator
  USING(SESSION_USER='platform_artifact_data_plane')
  WITH CHECK(SESSION_USER='platform_artifact_data_plane');
CREATE POLICY artifact_delivery_authority_definer
  ON platform.artifact_delivery_authorization TO platform_migrator
  USING(SESSION_USER IN ('platform_api','platform_artifact_data_plane'))
  WITH CHECK(SESSION_USER IN ('platform_api','platform_artifact_data_plane'));
CREATE POLICY artifact_version_delivery_definer
  ON platform.artifact_version TO platform_migrator
  USING(SESSION_USER IN ('platform_api','platform_artifact_data_plane'));
CREATE POLICY artifact_query_definer
  ON platform.artifact TO platform_migrator
  USING(SESSION_USER='platform_api');
CREATE POLICY media_candidate_artifact_query_definer
  ON platform.media_candidate TO platform_migrator
  USING(SESSION_USER='platform_api');
CREATE POLICY media_operation_artifact_query_definer
  ON platform.media_operation TO platform_migrator
  USING(SESSION_USER='platform_api');
CREATE POLICY media_gateway_evidence_artifact_query_definer
  ON platform.media_gateway_effect_evidence TO platform_migrator
  USING(SESSION_USER='platform_api');
REVOKE ALL ON TABLE platform.artifact_delivery_redemption_audit FROM PUBLIC;

CREATE TABLE platform.artifact_delivery_data_plane_role_identity (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK(singleton),
  role_name NAME NOT NULL UNIQUE CHECK(role_name='platform_artifact_data_plane'),
  role_oid OID NOT NULL UNIQUE
);
INSERT INTO platform.artifact_delivery_data_plane_role_identity(role_name,role_oid)
SELECT rolname,oid FROM pg_roles WHERE rolname='platform_artifact_data_plane';
ALTER TABLE platform.artifact_delivery_data_plane_role_identity ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.artifact_delivery_data_plane_role_identity FORCE ROW LEVEL SECURITY;
CREATE POLICY artifact_delivery_role_identity_definer
  ON platform.artifact_delivery_data_plane_role_identity TO platform_migrator
  USING(SESSION_USER='platform_artifact_data_plane');
REVOKE ALL ON TABLE platform.artifact_delivery_data_plane_role_identity FROM PUBLIC;

CREATE FUNCTION platform.assert_artifact_delivery_data_plane_role() RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,platform AS $$
DECLARE expected_name NAME; expected_oid OID; actual_oid OID;
BEGIN
  SELECT role_name,role_oid INTO STRICT expected_name,expected_oid
    FROM platform.artifact_delivery_data_plane_role_identity WHERE singleton;
  SELECT oid INTO STRICT actual_oid FROM pg_roles WHERE rolname=SESSION_USER;
  IF SESSION_USER<>expected_name::TEXT OR actual_oid<>expected_oid THEN
    RAISE EXCEPTION 'ARTIFACT_DELIVERY_DATA_PLANE_ROLE_FORBIDDEN';
  END IF;
END;
$$;

CREATE FUNCTION platform.list_owned_artifacts(
  p_created_before TIMESTAMPTZ,p_artifact_ref_before TEXT,p_limit INTEGER
) RETURNS TABLE(
  artifact_ref TEXT,current_artifact_version_ref TEXT,availability TEXT,title TEXT,
  created_at TIMESTAMPTZ,updated_at TIMESTAMPTZ
)
LANGUAGE plpgsql SECURITY DEFINER STABLE SET search_path=pg_catalog,platform AS $$
BEGIN
  IF SESSION_USER<>'platform_api' OR p_limit NOT BETWEEN 1 AND 101 OR
     ((p_created_before IS NULL)<>(p_artifact_ref_before IS NULL)) OR
     NULLIF(current_setting('app.site_id',true),'') IS NULL OR
     NULLIF(current_setting('app.subject_id',true),'') IS NULL OR
     NULLIF(current_setting('app.subject_generation',true),'') IS NULL OR
     NULLIF(current_setting('app.project_id',true),'') IS NULL THEN
    RAISE EXCEPTION 'ARTIFACT_OWNER_QUERY_FORBIDDEN';
  END IF;
  RETURN QUERY
  SELECT artifact.artifact_ref,artifact.current_artifact_version_ref,
    CASE
      WHEN version.state='ready_private' THEN 'ready'
      WHEN version.state='restricted' THEN 'restricted'
      WHEN version.state IN ('failed','reconciling') THEN 'unavailable'
      WHEN version.state IN ('purge_pending','purged') THEN 'deleted'
      ELSE 'processing'
    END,'Generated image'::TEXT,artifact.created_at,artifact.updated_at
  FROM platform.artifact artifact
  JOIN platform.artifact_version version
    ON version.artifact_ref=artifact.artifact_ref
   AND version.artifact_version_ref=artifact.current_artifact_version_ref
  WHERE artifact.site_ref=current_setting('app.site_id')
    AND artifact.subject_ref=current_setting('app.subject_id')
    AND artifact.subject_generation=current_setting('app.subject_generation')::BIGINT
    AND artifact.project_ref=current_setting('app.project_id')
    AND (p_created_before IS NULL OR artifact.created_at<p_created_before OR
      (artifact.created_at=p_created_before AND artifact.artifact_ref<p_artifact_ref_before))
  ORDER BY artifact.created_at DESC,artifact.artifact_ref DESC
  LIMIT p_limit;
END;
$$;

CREATE FUNCTION platform.get_owned_artifact(p_artifact_ref TEXT)
RETURNS TABLE(
  artifact_ref TEXT,current_artifact_version_ref TEXT,availability TEXT,title TEXT,
  created_at TIMESTAMPTZ,updated_at TIMESTAMPTZ
)
LANGUAGE plpgsql SECURITY DEFINER STABLE SET search_path=pg_catalog,platform AS $$
BEGIN
  IF SESSION_USER<>'platform_api' OR
     NULLIF(current_setting('app.site_id',true),'') IS NULL OR
     NULLIF(current_setting('app.subject_id',true),'') IS NULL OR
     NULLIF(current_setting('app.subject_generation',true),'') IS NULL OR
     NULLIF(current_setting('app.project_id',true),'') IS NULL THEN
    RAISE EXCEPTION 'ARTIFACT_OWNER_QUERY_FORBIDDEN';
  END IF;
  RETURN QUERY
  SELECT artifact.artifact_ref,artifact.current_artifact_version_ref,
    CASE
      WHEN version.state='ready_private' THEN 'ready'
      WHEN version.state='restricted' THEN 'restricted'
      WHEN version.state IN ('failed','reconciling') THEN 'unavailable'
      WHEN version.state IN ('purge_pending','purged') THEN 'deleted'
      ELSE 'processing'
    END,'Generated image'::TEXT,artifact.created_at,artifact.updated_at
  FROM platform.artifact artifact
  JOIN platform.artifact_version version
    ON version.artifact_ref=artifact.artifact_ref
   AND version.artifact_version_ref=artifact.current_artifact_version_ref
  WHERE artifact.artifact_ref=p_artifact_ref
    AND artifact.site_ref=current_setting('app.site_id')
    AND artifact.subject_ref=current_setting('app.subject_id')
    AND artifact.subject_generation=current_setting('app.subject_generation')::BIGINT
    AND artifact.project_ref=current_setting('app.project_id')
  LIMIT 1;
END;
$$;

CREATE FUNCTION platform.list_owned_artifact_versions(
  p_artifact_ref TEXT,p_created_before TIMESTAMPTZ,p_artifact_version_ref_before TEXT,p_limit INTEGER
) RETURNS TABLE(
  artifact_ref TEXT,artifact_version_ref TEXT,availability TEXT,owner_version BIGINT,
  version_number BIGINT,source_artifact_version_refs JSONB,byte_size BIGINT,media_type TEXT,
  width INTEGER,height INTEGER,created_at TIMESTAMPTZ
)
LANGUAGE plpgsql SECURITY DEFINER STABLE SET search_path=pg_catalog,platform AS $$
BEGIN
  IF SESSION_USER<>'platform_api' OR p_limit NOT BETWEEN 1 AND 101 OR
     ((p_created_before IS NULL)<>(p_artifact_version_ref_before IS NULL)) OR
     NULLIF(current_setting('app.site_id',true),'') IS NULL OR
     NULLIF(current_setting('app.subject_id',true),'') IS NULL OR
     NULLIF(current_setting('app.subject_generation',true),'') IS NULL OR
     NULLIF(current_setting('app.project_id',true),'') IS NULL THEN
    RAISE EXCEPTION 'ARTIFACT_OWNER_QUERY_FORBIDDEN';
  END IF;
  RETURN QUERY
  WITH ranked AS (
    SELECT version.*,
      row_number() OVER (PARTITION BY version.artifact_ref
        ORDER BY version.created_at,version.artifact_version_ref)::BIGINT AS version_number
    FROM platform.artifact_version version
    WHERE version.artifact_ref=p_artifact_ref
      AND version.site_ref=current_setting('app.site_id')
      AND version.subject_ref=current_setting('app.subject_id')
      AND version.subject_generation=current_setting('app.subject_generation')::BIGINT
      AND version.project_ref=current_setting('app.project_id')
  )
  SELECT version.artifact_ref,version.artifact_version_ref,
    CASE
      WHEN version.state='ready_private' THEN 'ready'
      WHEN version.state='restricted' THEN 'restricted'
      WHEN version.state IN ('failed','reconciling') THEN 'unavailable'
      WHEN version.state IN ('purge_pending','purged') THEN 'deleted'
      ELSE 'processing'
    END,version.owner_version,version.version_number,
    COALESCE((SELECT jsonb_agg(source.value->>'sourceVersionRef' ORDER BY source.ordinal)
      FROM jsonb_array_elements(operation.source_grants) WITH ORDINALITY AS source(value,ordinal)
      WHERE source.value?'sourceVersionRef'),'[]'::JSONB),
    version.byte_size,version.media_type,(evidence.fact->>'width')::INTEGER,
    (evidence.fact->>'height')::INTEGER,version.created_at
  FROM ranked version
  LEFT JOIN platform.media_candidate candidate
    ON candidate.artifact_ref=version.artifact_ref
   AND candidate.artifact_version_ref=version.artifact_version_ref
  LEFT JOIN platform.media_operation operation ON operation.operation_ref=candidate.operation_ref
  LEFT JOIN LATERAL (
    SELECT stored.fact FROM platform.media_gateway_effect_evidence stored
    WHERE stored.operation_ref=candidate.operation_ref
      AND stored.evidence_ref=candidate.gateway_output_evidence_ref AND stored.kind='output'
    ORDER BY stored.evidence_sequence DESC LIMIT 1
  ) evidence ON TRUE
  WHERE p_created_before IS NULL OR version.created_at<p_created_before OR
    (version.created_at=p_created_before AND version.artifact_version_ref<p_artifact_version_ref_before)
  ORDER BY version.created_at DESC,version.artifact_version_ref DESC
  LIMIT p_limit;
END;
$$;

CREATE FUNCTION platform.get_owned_artifact_version(
  p_artifact_ref TEXT,p_artifact_version_ref TEXT
) RETURNS TABLE(
  artifact_ref TEXT,artifact_version_ref TEXT,availability TEXT,owner_version BIGINT,
  version_number BIGINT,source_artifact_version_refs JSONB,byte_size BIGINT,media_type TEXT,
  width INTEGER,height INTEGER,created_at TIMESTAMPTZ
)
LANGUAGE plpgsql SECURITY DEFINER STABLE SET search_path=pg_catalog,platform AS $$
BEGIN
  IF SESSION_USER<>'platform_api' OR
     NULLIF(current_setting('app.site_id',true),'') IS NULL OR
     NULLIF(current_setting('app.subject_id',true),'') IS NULL OR
     NULLIF(current_setting('app.subject_generation',true),'') IS NULL OR
     NULLIF(current_setting('app.project_id',true),'') IS NULL THEN
    RAISE EXCEPTION 'ARTIFACT_OWNER_QUERY_FORBIDDEN';
  END IF;
  RETURN QUERY
  WITH ranked AS (
    SELECT version.*,
      row_number() OVER (PARTITION BY version.artifact_ref
        ORDER BY version.created_at,version.artifact_version_ref)::BIGINT AS version_number
    FROM platform.artifact_version version
    WHERE version.artifact_ref=p_artifact_ref
      AND version.site_ref=current_setting('app.site_id')
      AND version.subject_ref=current_setting('app.subject_id')
      AND version.subject_generation=current_setting('app.subject_generation')::BIGINT
      AND version.project_ref=current_setting('app.project_id')
  )
  SELECT version.artifact_ref,version.artifact_version_ref,
    CASE
      WHEN version.state='ready_private' THEN 'ready'
      WHEN version.state='restricted' THEN 'restricted'
      WHEN version.state IN ('failed','reconciling') THEN 'unavailable'
      WHEN version.state IN ('purge_pending','purged') THEN 'deleted'
      ELSE 'processing'
    END,version.owner_version,version.version_number,
    COALESCE((SELECT jsonb_agg(source.value->>'sourceVersionRef' ORDER BY source.ordinal)
      FROM jsonb_array_elements(operation.source_grants) WITH ORDINALITY AS source(value,ordinal)
      WHERE source.value?'sourceVersionRef'),'[]'::JSONB),
    version.byte_size,version.media_type,(evidence.fact->>'width')::INTEGER,
    (evidence.fact->>'height')::INTEGER,version.created_at
  FROM ranked version
  LEFT JOIN platform.media_candidate candidate
    ON candidate.artifact_ref=version.artifact_ref
   AND candidate.artifact_version_ref=version.artifact_version_ref
  LEFT JOIN platform.media_operation operation ON operation.operation_ref=candidate.operation_ref
  LEFT JOIN LATERAL (
    SELECT stored.fact FROM platform.media_gateway_effect_evidence stored
    WHERE stored.operation_ref=candidate.operation_ref
      AND stored.evidence_ref=candidate.gateway_output_evidence_ref AND stored.kind='output'
    ORDER BY stored.evidence_sequence DESC LIMIT 1
  ) evidence ON TRUE
  WHERE version.artifact_version_ref=p_artifact_version_ref
  LIMIT 1;
END;
$$;

CREATE FUNCTION platform.create_artifact_delivery_authorization(
  p_authorization_ref TEXT,p_capability_digest CHAR(64),p_site_ref TEXT,p_subject_ref TEXT,
  p_subject_generation BIGINT,p_project_ref TEXT,p_artifact_ref TEXT,p_artifact_version_ref TEXT,
  p_purpose TEXT,p_audience TEXT,p_suggested_file_name TEXT,
  p_site_release_ref TEXT,p_workload_identity_ref TEXT,
  p_workload_binding_epoch BIGINT,p_site_security_epoch BIGINT,p_issued_at TIMESTAMPTZ,
  p_expires_at TIMESTAMPTZ,p_revocation_epoch BIGINT
) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,platform AS $$
BEGIN
  IF SESSION_USER<>'platform_api' OR p_revocation_epoch<>1 OR p_expires_at<=p_issued_at OR
     p_expires_at>p_issued_at+interval '5 minutes' OR
     (p_suggested_file_name IS NOT NULL AND (p_purpose<>'download' OR
       length(p_suggested_file_name) NOT BETWEEN 1 AND 255 OR
       p_suggested_file_name ~ E'[\\x00-\\x1f\\x7f/\\\\]')) OR
     p_site_ref<>NULLIF(current_setting('app.site_id',true),'') OR
     p_subject_ref<>NULLIF(current_setting('app.subject_id',true),'') OR
     p_subject_generation<>NULLIF(current_setting('app.subject_generation',true),'')::BIGINT OR
     p_project_ref<>NULLIF(current_setting('app.project_id',true),'') OR
     p_site_release_ref<>NULLIF(current_setting('app.site_release_ref',true),'') OR
     p_workload_identity_ref<>NULLIF(current_setting('app.workload_identity_ref',true),'') OR
     p_workload_binding_epoch<>NULLIF(current_setting('app.workload_binding_epoch',true),'')::BIGINT OR
     p_site_security_epoch<>NULLIF(current_setting('app.site_security_epoch',true),'')::BIGINT THEN
    RAISE EXCEPTION 'ARTIFACT_DELIVERY_AUTHORIZATION_CREATE_FORBIDDEN';
  END IF;
  INSERT INTO platform.artifact_delivery_authorization(
    authorization_ref,capability_digest,site_ref,subject_ref,subject_generation,project_ref,
    artifact_ref,artifact_version_ref,purpose,audience,suggested_file_name,
    site_release_ref,workload_identity_ref,
    workload_binding_epoch,site_security_epoch,issued_at,expires_at,revocation_epoch
  ) SELECT p_authorization_ref,p_capability_digest,p_site_ref,p_subject_ref,p_subject_generation,
    p_project_ref,p_artifact_ref,p_artifact_version_ref,p_purpose,p_audience,p_suggested_file_name,
    p_site_release_ref,p_workload_identity_ref,p_workload_binding_epoch,p_site_security_epoch,
    p_issued_at,p_expires_at,p_revocation_epoch
  WHERE EXISTS (SELECT 1 FROM platform.artifact_version version
    WHERE version.artifact_ref=p_artifact_ref AND version.artifact_version_ref=p_artifact_version_ref
      AND version.site_ref=p_site_ref AND version.subject_ref=p_subject_ref
      AND version.subject_generation=p_subject_generation AND version.project_ref=p_project_ref
      AND version.state='ready_private');
  IF NOT FOUND THEN RAISE EXCEPTION 'ARTIFACT_VERSION_NOT_READY'; END IF;
  RETURN TRUE;
END;
$$;

CREATE FUNCTION platform.revoke_owned_artifact_delivery_authorization(
  p_authorization_ref TEXT,p_revoked_at TIMESTAMPTZ,p_reason TEXT
) RETURNS TABLE(state TEXT,revoked_at TIMESTAMPTZ)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,platform AS $$
DECLARE current_row platform.artifact_delivery_authorization%ROWTYPE;
BEGIN
  IF SESSION_USER<>'platform_api' OR
     p_revoked_at<statement_timestamp()-interval '5 minutes' OR
     p_revoked_at>statement_timestamp()+interval '5 minutes' OR
     (p_reason IS NOT NULL AND (length(p_reason) NOT BETWEEN 1 AND 256 OR
       p_reason ~ E'[\\x00-\\x1f\\x7f]')) THEN
    RAISE EXCEPTION 'ARTIFACT_DELIVERY_REVOCATION_FORBIDDEN';
  END IF;
  SELECT a.* INTO current_row
  FROM platform.artifact_delivery_authorization a
  WHERE a.authorization_ref=p_authorization_ref
    AND a.site_ref=NULLIF(current_setting('app.site_id',true),'')
    AND a.subject_ref=NULLIF(current_setting('app.subject_id',true),'')
    AND a.subject_generation=NULLIF(current_setting('app.subject_generation',true),'')::BIGINT
    AND a.project_ref=NULLIF(current_setting('app.project_id',true),'')
  FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  IF current_row.revoked_at IS NOT NULL THEN
    RETURN QUERY SELECT 'already_revoked'::TEXT,current_row.revoked_at;
  ELSIF current_row.expires_at<=p_revoked_at THEN
    RETURN QUERY SELECT 'expired'::TEXT,p_revoked_at;
  ELSE
    UPDATE platform.artifact_delivery_authorization a
      SET revoked_at=p_revoked_at,revocation_reason=p_reason,
          revocation_epoch=a.revocation_epoch+1
      WHERE a.authorization_ref=p_authorization_ref;
    RETURN QUERY SELECT 'revoked'::TEXT,p_revoked_at;
  END IF;
END;
$$;

CREATE FUNCTION platform.find_artifact_delivery_authorization_by_capability(p_capability_digest CHAR(64))
RETURNS SETOF platform.artifact_delivery_authorization
LANGUAGE plpgsql SECURITY DEFINER STABLE SET search_path=pg_catalog,platform AS $$
BEGIN
  PERFORM platform.assert_artifact_delivery_data_plane_role();
  RETURN QUERY SELECT a.* FROM platform.artifact_delivery_authorization a
    WHERE a.capability_digest=p_capability_digest LIMIT 1;
END;
$$;

CREATE FUNCTION platform.find_artifact_delivery_authorization_by_reference(p_authorization_ref TEXT)
RETURNS SETOF platform.artifact_delivery_authorization
LANGUAGE plpgsql SECURITY DEFINER STABLE SET search_path=pg_catalog,platform AS $$
BEGIN
  IF SESSION_USER<>'platform_api' THEN RAISE EXCEPTION 'ARTIFACT_DELIVERY_AUTHORITY_ROLE_FORBIDDEN'; END IF;
  RETURN QUERY SELECT a.* FROM platform.artifact_delivery_authorization a
    WHERE a.authorization_ref=p_authorization_ref LIMIT 1;
END;
$$;

CREATE FUNCTION platform.revoke_artifact_delivery_authorization(
  p_authorization_ref TEXT,p_revoked_at TIMESTAMPTZ,p_expected_revocation_epoch BIGINT
) RETURNS SETOF platform.artifact_delivery_authorization
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,platform AS $$
BEGIN
  IF SESSION_USER<>'platform_api' THEN RAISE EXCEPTION 'ARTIFACT_DELIVERY_AUTHORITY_ROLE_FORBIDDEN'; END IF;
  RETURN QUERY UPDATE platform.artifact_delivery_authorization a
    SET revoked_at=p_revoked_at,revocation_epoch=revocation_epoch+1
    WHERE a.authorization_ref=p_authorization_ref
      AND a.revocation_epoch=p_expected_revocation_epoch
      AND a.revoked_at IS NULL
    RETURNING a.*;
END;
$$;

CREATE FUNCTION platform.begin_artifact_delivery_redemption(
  p_redemption_ref TEXT,p_authorization_ref TEXT,p_request_ref TEXT,p_site_ref TEXT,
  p_site_release_ref TEXT,p_workload_identity_ref TEXT,p_workload_binding_epoch BIGINT,
  p_site_security_epoch BIGINT,p_range_header TEXT
) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,platform AS $$
DECLARE admitted platform.artifact_delivery_authorization%ROWTYPE;
BEGIN
  PERFORM platform.assert_artifact_delivery_data_plane_role();
  SELECT a.* INTO admitted FROM platform.artifact_delivery_authorization a
    JOIN platform.artifact_version version
      ON version.artifact_ref=a.artifact_ref
     AND version.artifact_version_ref=a.artifact_version_ref
     AND version.site_ref=a.site_ref AND version.subject_ref=a.subject_ref
     AND version.subject_generation=a.subject_generation
     AND version.project_ref=a.project_ref
    WHERE a.authorization_ref=p_authorization_ref
      AND a.site_ref=p_site_ref
      AND a.site_release_ref=p_site_release_ref
      AND a.workload_identity_ref=p_workload_identity_ref
      AND a.workload_binding_epoch=p_workload_binding_epoch
      AND a.site_security_epoch=p_site_security_epoch
      AND a.revoked_at IS NULL AND a.expires_at>statement_timestamp()
      AND version.state='ready_private'
    FOR SHARE OF a;
  IF NOT FOUND THEN RAISE EXCEPTION 'ARTIFACT_DELIVERY_AUTHORIZATION_REJECTED'; END IF;
  INSERT INTO platform.artifact_delivery_redemption_audit(
    redemption_ref,authorization_ref,request_ref,site_ref,site_release_ref,workload_identity_ref,
    workload_binding_epoch,site_security_epoch,range_header,state,attempted_at
  ) VALUES(p_redemption_ref,p_authorization_ref,p_request_ref,p_site_ref,p_site_release_ref,
    p_workload_identity_ref,p_workload_binding_epoch,p_site_security_epoch,p_range_header,
    'pending',statement_timestamp());
  RETURN TRUE;
END;
$$;

CREATE FUNCTION platform.complete_artifact_delivery_stream(
  p_redemption_ref TEXT,p_bytes_emitted BIGINT
) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,platform AS $$
BEGIN
  PERFORM platform.assert_artifact_delivery_data_plane_role();
  UPDATE platform.artifact_delivery_redemption_audit audit
    SET state='stream_completed',stream_completed_at=statement_timestamp(),bytes_emitted=p_bytes_emitted
    WHERE audit.redemption_ref=p_redemption_ref AND audit.state='pending';
  RETURN FOUND;
END;
$$;

CREATE FUNCTION platform.fail_artifact_delivery_stream(
  p_redemption_ref TEXT,p_failure_code TEXT
) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,platform AS $$
BEGIN
  PERFORM platform.assert_artifact_delivery_data_plane_role();
  IF p_failure_code NOT IN ('range_rejected','storage_failed','client_aborted') THEN
    RAISE EXCEPTION 'ARTIFACT_DELIVERY_FAILURE_CODE_INVALID';
  END IF;
  UPDATE platform.artifact_delivery_redemption_audit audit
    SET state='failed',failed_at=statement_timestamp(),failure_code=p_failure_code
    WHERE audit.redemption_ref=p_redemption_ref AND audit.state='pending';
  RETURN FOUND;
END;
$$;

REVOKE ALL ON FUNCTION platform.assert_artifact_delivery_data_plane_role() FROM PUBLIC;
REVOKE ALL ON FUNCTION platform.list_owned_artifacts(TIMESTAMPTZ,TEXT,INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION platform.get_owned_artifact(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION platform.list_owned_artifact_versions(TEXT,TIMESTAMPTZ,TEXT,INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION platform.get_owned_artifact_version(TEXT,TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION platform.create_artifact_delivery_authorization(
  TEXT,CHAR(64),TEXT,TEXT,BIGINT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,BIGINT,BIGINT,
  TIMESTAMPTZ,TIMESTAMPTZ,BIGINT) FROM PUBLIC;
REVOKE ALL ON FUNCTION platform.find_artifact_delivery_authorization_by_capability(CHAR(64)) FROM PUBLIC;
REVOKE ALL ON FUNCTION platform.find_artifact_delivery_authorization_by_reference(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION platform.revoke_artifact_delivery_authorization(TEXT,TIMESTAMPTZ,BIGINT) FROM PUBLIC;
REVOKE ALL ON FUNCTION platform.revoke_owned_artifact_delivery_authorization(TEXT,TIMESTAMPTZ,TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION platform.begin_artifact_delivery_redemption(
  TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,BIGINT,BIGINT,TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION platform.complete_artifact_delivery_stream(TEXT,BIGINT) FROM PUBLIC;
REVOKE ALL ON FUNCTION platform.fail_artifact_delivery_stream(TEXT,TEXT) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION platform.assert_artifact_delivery_data_plane_role()
  TO platform_artifact_data_plane;
GRANT EXECUTE ON FUNCTION platform.find_artifact_delivery_authorization_by_capability(CHAR(64)),
  platform.begin_artifact_delivery_redemption(TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,BIGINT,BIGINT,TEXT),
  platform.complete_artifact_delivery_stream(TEXT,BIGINT),
  platform.fail_artifact_delivery_stream(TEXT,TEXT)
  TO platform_artifact_data_plane;
GRANT EXECUTE ON FUNCTION platform.create_artifact_delivery_authorization(
  TEXT,CHAR(64),TEXT,TEXT,BIGINT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,BIGINT,BIGINT,
  TIMESTAMPTZ,TIMESTAMPTZ,BIGINT),
  platform.find_artifact_delivery_authorization_by_reference(TEXT),
  platform.revoke_artifact_delivery_authorization(TEXT,TIMESTAMPTZ,BIGINT),
  platform.list_owned_artifacts(TIMESTAMPTZ,TEXT,INTEGER),
  platform.get_owned_artifact(TEXT),
  platform.list_owned_artifact_versions(TEXT,TIMESTAMPTZ,TEXT,INTEGER),
  platform.get_owned_artifact_version(TEXT,TEXT),
  platform.revoke_owned_artifact_delivery_authorization(TEXT,TIMESTAMPTZ,TEXT)
  TO platform_api;
REVOKE CREATE ON SCHEMA platform FROM platform_artifact_data_plane;
