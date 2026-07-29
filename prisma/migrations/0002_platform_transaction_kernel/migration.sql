SET statement_timeout = '30s';
SET lock_timeout = '5s';
SET idle_in_transaction_session_timeout = '30s';

CREATE TABLE platform.command_receipt (
  command_id UUID PRIMARY KEY,
  environment TEXT NOT NULL,
  region TEXT NOT NULL,
  caller_identity TEXT NOT NULL,
  operation TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_digest CHAR(64) NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','succeeded','failed','outcome_unknown')),
  result JSONB,
  result_digest CHAR(64) CHECK (result_digest IS NULL OR result_digest ~ '^[a-f0-9]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (environment, caller_identity, operation, idempotency_key),
  CHECK ((state = 'pending' AND result_digest IS NULL) OR state <> 'pending')
);

CREATE TABLE platform.outbox_event (
  event_id UUID PRIMARY KEY,
  owner TEXT NOT NULL,
  event_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  payload JSONB NOT NULL,
  payload_digest CHAR(64) NOT NULL CHECK (payload_digest ~ '^[a-f0-9]{64}$'),
  correlation_id TEXT NOT NULL,
  causation_id TEXT,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','leased','delivered','dead_letter')),
  attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  lease_owner TEXT,
  lease_token TEXT,
  lease_expires_at TIMESTAMPTZ,
  last_error_code TEXT,
  delivered_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((state = 'leased') = (lease_owner IS NOT NULL AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL))
);
CREATE INDEX outbox_claim_idx ON platform.outbox_event (owner, available_at, created_at)
  WHERE state IN ('pending','leased');

CREATE TABLE platform.inbox_delivery (
  delivery_id UUID PRIMARY KEY,
  provider TEXT NOT NULL,
  operation TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_digest CHAR(64) NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  state TEXT NOT NULL DEFAULT 'processing' CHECK (state IN ('processing','outcome_unknown','completed','dead_letter')),
  handler_id TEXT,
  lease_token TEXT,
  lease_expires_at TIMESTAMPTZ,
  attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  outcome JSONB,
  outcome_digest CHAR(64) CHECK (outcome_digest IS NULL OR outcome_digest ~ '^[a-f0-9]{64}$'),
  last_observation_code TEXT,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider, operation, idempotency_key),
  CHECK ((state = 'processing') = (handler_id IS NOT NULL AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL))
);
CREATE INDEX inbox_reclaim_idx ON platform.inbox_delivery (lease_expires_at)
  WHERE state = 'processing';

REVOKE ALL ON platform.command_receipt, platform.outbox_event, platform.inbox_delivery FROM PUBLIC;
