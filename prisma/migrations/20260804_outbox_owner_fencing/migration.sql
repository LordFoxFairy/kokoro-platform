SET statement_timeout = '30s';
SET lock_timeout = '5s';
SET idle_in_transaction_session_timeout = '30s';

-- Runtime consumers share the durable kernel table, but they are not one
-- authority. RLS is keyed by the exact authenticated PostgreSQL role through
-- per-role policies installed by the migrator; application GUCs and table
-- owner bypass are not part of this boundary.
ALTER TABLE platform.outbox_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.outbox_event FORCE ROW LEVEL SECURITY;

ALTER TABLE platform.platform_foundation
  ADD COLUMN "outboxPolicyAuthority" JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD CONSTRAINT platform_foundation_outbox_policy_authority_array
    CHECK (jsonb_typeof("outboxPolicyAuthority") = 'array');

COMMENT ON TABLE platform.outbox_event IS
  'Shared durable outbox; runtime visibility and mutation are fenced by exact database role and owner policies.';
