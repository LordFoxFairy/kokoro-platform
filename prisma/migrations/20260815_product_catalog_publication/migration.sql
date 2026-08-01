-- Global Product/Surface catalog and LaunchProductProfile publication authority.
-- Site release admission consumes exact immutable bindings; it does not own them.

CREATE TABLE platform.product_catalog_publication_head (
  publication_kind TEXT PRIMARY KEY CHECK (publication_kind IN ('catalog','profile')),
  head_revision NUMERIC(20,0) NOT NULL CHECK (head_revision >= 0 AND head_revision <= 18446744073709551615),
  head_ref TEXT,
  head_digest CHAR(71),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CHECK ((head_revision = 0 AND head_ref IS NULL AND head_digest IS NULL) OR
         (head_revision > 0 AND head_ref IS NOT NULL AND head_digest ~ '^sha256:[0-9a-f]{64}$'))
);

INSERT INTO platform.product_catalog_publication_head(publication_kind,head_revision)
VALUES ('catalog',0),('profile',0);

CREATE TABLE platform.product_surface_catalog_revision (
  catalog_revision_ref TEXT NOT NULL,
  revision NUMERIC(20,0) NOT NULL CHECK (revision > 0 AND revision <= 18446744073709551615),
  digest CHAR(71) NOT NULL CHECK (digest ~ '^sha256:[0-9a-f]{64}$'),
  canonical_payload JSONB NOT NULL,
  canonical_bytes BYTEA NOT NULL CHECK (octet_length(canonical_bytes) BETWEEN 2 AND 4194304),
  published_at TIMESTAMPTZ NOT NULL,
  published_by TEXT NOT NULL,
  command_id TEXT NOT NULL UNIQUE REFERENCES platform.command_receipt(command_id),
  PRIMARY KEY (catalog_revision_ref,revision),
  UNIQUE (catalog_revision_ref,revision,digest)
);

CREATE TABLE platform.launch_product_profile_revision (
  profile_revision_ref TEXT NOT NULL,
  revision NUMERIC(20,0) NOT NULL CHECK (revision > 0 AND revision <= 18446744073709551615),
  digest CHAR(71) NOT NULL CHECK (digest ~ '^sha256:[0-9a-f]{64}$'),
  canonical_payload JSONB NOT NULL,
  canonical_bytes BYTEA NOT NULL CHECK (octet_length(canonical_bytes) BETWEEN 2 AND 4194304),
  catalog_revision_ref TEXT NOT NULL,
  catalog_revision NUMERIC(20,0) NOT NULL CHECK (catalog_revision > 0 AND catalog_revision <= 18446744073709551615),
  catalog_digest CHAR(71) NOT NULL CHECK (catalog_digest ~ '^sha256:[0-9a-f]{64}$'),
  target_site_kind_ref TEXT NOT NULL,
  published_at TIMESTAMPTZ NOT NULL,
  published_by TEXT NOT NULL,
  command_id TEXT NOT NULL UNIQUE REFERENCES platform.command_receipt(command_id),
  PRIMARY KEY (profile_revision_ref,revision),
  UNIQUE (profile_revision_ref,revision,digest),
  FOREIGN KEY (catalog_revision_ref,catalog_revision,catalog_digest)
    REFERENCES platform.product_surface_catalog_revision(catalog_revision_ref,revision,digest)
);

CREATE INDEX launch_product_profile_catalog_binding
  ON platform.launch_product_profile_revision(catalog_revision_ref,catalog_revision,catalog_digest);
CREATE INDEX launch_product_profile_site_kind
  ON platform.launch_product_profile_revision(target_site_kind_ref,revision DESC);

CREATE TABLE platform.product_catalog_publication_audit (
  command_id TEXT PRIMARY KEY REFERENCES platform.command_receipt(command_id),
  operation TEXT NOT NULL CHECK (operation IN ('product.catalog.publish','product.launch-profile.publish')),
  revision_ref TEXT NOT NULL,
  revision NUMERIC(20,0) NOT NULL CHECK (revision > 0 AND revision <= 18446744073709551615),
  digest CHAR(71) NOT NULL CHECK (digest ~ '^sha256:[0-9a-f]{64}$'),
  catalog_revision_ref TEXT,
  catalog_revision NUMERIC(20,0),
  catalog_digest CHAR(71),
  expected_head_revision NUMERIC(20,0) NOT NULL
    CHECK (expected_head_revision >= 0 AND expected_head_revision <= 18446744073709551615),
  reason TEXT NOT NULL CHECK (char_length(reason) BETWEEN 3 AND 1024),
  actor_subject_id TEXT NOT NULL,
  environment TEXT NOT NULL,
  region TEXT NOT NULL,
  replayed BOOLEAN NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CHECK ((operation = 'product.catalog.publish' AND catalog_revision_ref IS NULL AND
          catalog_revision IS NULL AND catalog_digest IS NULL) OR
         (operation = 'product.launch-profile.publish' AND catalog_revision_ref IS NOT NULL AND
          catalog_revision > 0 AND catalog_revision <= 18446744073709551615 AND
          catalog_digest ~ '^sha256:[0-9a-f]{64}$'))
);

-- Owner-scoped success attestation. The mutable generic command receipt only
-- coordinates execution; replay authority comes from this append-only row,
-- the immutable audit row, and the immutable published revision together.
CREATE TABLE platform.product_catalog_publication_receipt (
  command_id TEXT PRIMARY KEY REFERENCES platform.product_catalog_publication_audit(command_id),
  operation TEXT NOT NULL CHECK (operation IN ('product.catalog.publish','product.launch-profile.publish')),
  environment TEXT NOT NULL,
  region TEXT NOT NULL,
  caller_identity TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_digest CHAR(64) NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  revision_ref TEXT NOT NULL,
  revision NUMERIC(20,0) NOT NULL CHECK (revision > 0 AND revision <= 18446744073709551615),
  digest CHAR(71) NOT NULL CHECK (digest ~ '^sha256:[0-9a-f]{64}$'),
  catalog_revision_ref TEXT,
  catalog_revision NUMERIC(20,0),
  catalog_digest CHAR(71),
  publication_replayed BOOLEAN NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (environment,caller_identity,operation,idempotency_key),
  CHECK ((operation = 'product.catalog.publish' AND catalog_revision_ref IS NULL AND
          catalog_revision IS NULL AND catalog_digest IS NULL) OR
         (operation = 'product.launch-profile.publish' AND catalog_revision_ref IS NOT NULL AND
          catalog_revision > 0 AND catalog_revision <= 18446744073709551615 AND
          catalog_digest ~ '^sha256:[0-9a-f]{64}$'))
);

CREATE FUNCTION platform.reject_immutable_product_publication_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'PRODUCT_PUBLICATION_IMMUTABLE';
END;
$$;

CREATE TRIGGER product_surface_catalog_revision_immutable
  BEFORE UPDATE OR DELETE ON platform.product_surface_catalog_revision
  FOR EACH ROW EXECUTE FUNCTION platform.reject_immutable_product_publication_mutation();
CREATE TRIGGER launch_product_profile_revision_immutable
  BEFORE UPDATE OR DELETE ON platform.launch_product_profile_revision
  FOR EACH ROW EXECUTE FUNCTION platform.reject_immutable_product_publication_mutation();
CREATE TRIGGER product_catalog_publication_audit_immutable
  BEFORE UPDATE OR DELETE ON platform.product_catalog_publication_audit
  FOR EACH ROW EXECUTE FUNCTION platform.reject_immutable_product_publication_mutation();
CREATE TRIGGER product_catalog_publication_receipt_immutable
  BEFORE UPDATE OR DELETE ON platform.product_catalog_publication_receipt
  FOR EACH ROW EXECUTE FUNCTION platform.reject_immutable_product_publication_mutation();

ALTER TABLE platform.product_catalog_publication_head ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.product_catalog_publication_head FORCE ROW LEVEL SECURITY;
ALTER TABLE platform.product_surface_catalog_revision ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.product_surface_catalog_revision FORCE ROW LEVEL SECURITY;
ALTER TABLE platform.launch_product_profile_revision ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.launch_product_profile_revision FORCE ROW LEVEL SECURITY;
ALTER TABLE platform.product_catalog_publication_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.product_catalog_publication_audit FORCE ROW LEVEL SECURITY;
ALTER TABLE platform.product_catalog_publication_receipt ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.product_catalog_publication_receipt FORCE ROW LEVEL SECURITY;

CREATE POLICY product_catalog_head_admin_global ON platform.product_catalog_publication_head
  USING (
    current_setting('app.workload_kind',true)='platform_admin' AND
    current_setting('app.actor_kind',true)='operator' AND
    COALESCE(current_setting('app.site_id',true),'')='' AND
    current_setting('app.operation',true) IN ('product.catalog.publish','product.launch-profile.publish') AND
    publication_kind=CASE current_setting('app.operation',true)
      WHEN 'product.catalog.publish' THEN 'catalog' ELSE 'profile' END AND
    COALESCE(current_setting('app.scopes',true),'[]')::JSONB ? 'admin:global' AND
    COALESCE(current_setting('app.scopes',true),'[]')::JSONB ? current_setting('app.operation',true)
  ) WITH CHECK (
    current_setting('app.workload_kind',true)='platform_admin' AND
    current_setting('app.actor_kind',true)='operator' AND
    COALESCE(current_setting('app.site_id',true),'')='' AND
    current_setting('app.operation',true) IN ('product.catalog.publish','product.launch-profile.publish') AND
    publication_kind=CASE current_setting('app.operation',true)
      WHEN 'product.catalog.publish' THEN 'catalog' ELSE 'profile' END AND
    COALESCE(current_setting('app.scopes',true),'[]')::JSONB ? 'admin:global' AND
    COALESCE(current_setting('app.scopes',true),'[]')::JSONB ? current_setting('app.operation',true)
  );

CREATE POLICY product_catalog_revision_admin_global ON platform.product_surface_catalog_revision
  USING (
    current_setting('app.workload_kind',true)='platform_admin' AND
    current_setting('app.actor_kind',true)='operator' AND
    COALESCE(current_setting('app.site_id',true),'')='' AND
    current_setting('app.operation',true) IN ('product.catalog.publish','product.launch-profile.publish') AND
    COALESCE(current_setting('app.scopes',true),'[]')::JSONB ? 'admin:global' AND
    COALESCE(current_setting('app.scopes',true),'[]')::JSONB ? current_setting('app.operation',true)
  ) WITH CHECK (
    current_setting('app.workload_kind',true)='platform_admin' AND
    current_setting('app.actor_kind',true)='operator' AND
    COALESCE(current_setting('app.site_id',true),'')='' AND
    current_setting('app.operation',true)='product.catalog.publish' AND
    COALESCE(current_setting('app.scopes',true),'[]')::JSONB ? 'admin:global' AND
    COALESCE(current_setting('app.scopes',true),'[]')::JSONB ? 'product.catalog.publish'
  );

CREATE POLICY launch_product_profile_admin_global ON platform.launch_product_profile_revision
  USING (
    current_setting('app.workload_kind',true)='platform_admin' AND
    current_setting('app.actor_kind',true)='operator' AND
    COALESCE(current_setting('app.site_id',true),'')='' AND
    current_setting('app.operation',true)='product.launch-profile.publish' AND
    COALESCE(current_setting('app.scopes',true),'[]')::JSONB ? 'admin:global' AND
    COALESCE(current_setting('app.scopes',true),'[]')::JSONB ? 'product.launch-profile.publish'
  ) WITH CHECK (
    current_setting('app.workload_kind',true)='platform_admin' AND
    current_setting('app.actor_kind',true)='operator' AND
    COALESCE(current_setting('app.site_id',true),'')='' AND
    current_setting('app.operation',true)='product.launch-profile.publish' AND
    COALESCE(current_setting('app.scopes',true),'[]')::JSONB ? 'admin:global' AND
    COALESCE(current_setting('app.scopes',true),'[]')::JSONB ? 'product.launch-profile.publish'
  );

CREATE POLICY product_catalog_audit_admin_global ON platform.product_catalog_publication_audit
  USING (
    current_setting('app.workload_kind',true)='platform_admin' AND
    current_setting('app.actor_kind',true)='operator' AND
    COALESCE(current_setting('app.site_id',true),'')='' AND
    operation=current_setting('app.operation',true) AND
    COALESCE(current_setting('app.scopes',true),'[]')::JSONB ? 'admin:global' AND
    COALESCE(current_setting('app.scopes',true),'[]')::JSONB ? operation
  ) WITH CHECK (
    current_setting('app.workload_kind',true)='platform_admin' AND
    current_setting('app.actor_kind',true)='operator' AND
    COALESCE(current_setting('app.site_id',true),'')='' AND
    operation=current_setting('app.operation',true) AND
    COALESCE(current_setting('app.scopes',true),'[]')::JSONB ? 'admin:global' AND
    COALESCE(current_setting('app.scopes',true),'[]')::JSONB ? operation
  );

CREATE POLICY product_catalog_receipt_admin_global ON platform.product_catalog_publication_receipt
  USING (
    current_setting('app.workload_kind',true)='platform_admin' AND
    current_setting('app.actor_kind',true)='operator' AND
    COALESCE(current_setting('app.site_id',true),'')='' AND
    operation=current_setting('app.operation',true) AND
    COALESCE(current_setting('app.scopes',true),'[]')::JSONB ? 'admin:global' AND
    COALESCE(current_setting('app.scopes',true),'[]')::JSONB ? operation
  ) WITH CHECK (
    current_setting('app.workload_kind',true)='platform_admin' AND
    current_setting('app.actor_kind',true)='operator' AND
    COALESCE(current_setting('app.site_id',true),'')='' AND
    operation=current_setting('app.operation',true) AND
    COALESCE(current_setting('app.scopes',true),'[]')::JSONB ? 'admin:global' AND
    COALESCE(current_setting('app.scopes',true),'[]')::JSONB ? operation
  );

REVOKE ALL ON TABLE platform.product_catalog_publication_head FROM PUBLIC;
REVOKE ALL ON TABLE platform.product_surface_catalog_revision FROM PUBLIC;
REVOKE ALL ON TABLE platform.launch_product_profile_revision FROM PUBLIC;
REVOKE ALL ON TABLE platform.product_catalog_publication_audit FROM PUBLIC;
REVOKE ALL ON TABLE platform.product_catalog_publication_receipt FROM PUBLIC;
REVOKE ALL ON FUNCTION platform.reject_immutable_product_publication_mutation() FROM PUBLIC;
