CREATE SCHEMA platform;
CREATE TABLE platform.environment_identity (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  environment text NOT NULL CHECK (environment IN ('development', 'test', 'production'))
);
CREATE TABLE platform.audit_events (
  id uuid PRIMARY KEY,
  occurred_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  action text NOT NULL CHECK (action = 'system.error'),
  request_id uuid NOT NULL,
  outcome text NOT NULL CHECK (outcome = 'failure'),
  retention_class text NOT NULL DEFAULT 'general_error_30d' CHECK (retention_class = 'general_error_30d'),
  expires_at timestamptz NOT NULL DEFAULT (CURRENT_TIMESTAMP + interval '30 days'),
  CHECK (expires_at > occurred_at)
);
CREATE INDEX audit_events_expiry_idx ON platform.audit_events (expires_at);
CREATE INDEX audit_events_request_idx ON platform.audit_events (request_id);
REVOKE ALL ON SCHEMA platform FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA platform FROM PUBLIC;
