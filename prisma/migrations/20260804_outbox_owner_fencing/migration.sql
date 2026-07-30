SET statement_timeout = '30s';
SET lock_timeout = '5s';
SET idle_in_transaction_session_timeout = '30s';

-- Runtime consumers share the durable kernel table, but they are not one
-- authority. RLS is keyed by unforgeable PostgreSQL role membership through
-- per-role policies installed by the migrator; application GUCs are not part
-- of this boundary. The schema owner deliberately retains the normal owner
-- bypass for migrations and narrow SECURITY DEFINER producers.
ALTER TABLE platform.outbox_event ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE platform.outbox_event IS
  'Shared durable outbox; runtime visibility and mutation are fenced by exact database role and owner policies.';
