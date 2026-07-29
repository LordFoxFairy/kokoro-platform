-- Platform has one PostgreSQL schema and one migration authority.
-- Keep DDL bounded so deploys fail instead of waiting behind application traffic.
SET statement_timeout = '30s';
SET lock_timeout = '5s';
SET idle_in_transaction_session_timeout = '30s';

DO $$
DECLARE
    existing_owner TEXT;
    public_has_privilege BOOLEAN;
BEGIN
    SELECT owner_role.rolname,
           EXISTS (
               SELECT 1
               FROM aclexplode(COALESCE(namespace_row.nspacl, acldefault('n', namespace_row.nspowner))) acl
               WHERE acl.grantee = 0
                 AND acl.privilege_type IN ('USAGE', 'CREATE')
           )
      INTO existing_owner, public_has_privilege
      FROM pg_namespace namespace_row
      JOIN pg_roles owner_role ON owner_role.oid = namespace_row.nspowner
     WHERE namespace_row.nspname = 'platform';

    IF existing_owner IS NULL THEN
        EXECUTE format('CREATE SCHEMA platform AUTHORIZATION %I', current_user);
    ELSIF existing_owner <> current_user OR public_has_privilege THEN
        RAISE EXCEPTION 'platform schema authority mismatch';
    END IF;
END
$$;

CREATE TABLE "platform"."platform_foundation" (
    "singleton" BOOLEAN NOT NULL DEFAULT TRUE,
    "schemaVersion" INTEGER NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_foundation_pkey" PRIMARY KEY ("singleton"),
    CONSTRAINT "platform_foundation_singleton_check" CHECK ("singleton" IS TRUE),
    CONSTRAINT "platform_foundation_schema_version_check" CHECK ("schemaVersion" > 0)
);

INSERT INTO "platform"."platform_foundation" (
    "singleton",
    "schemaVersion"
) VALUES (TRUE, 1)
ON CONFLICT ("singleton") DO NOTHING;
