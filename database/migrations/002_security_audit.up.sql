CREATE TABLE platform.security_events (
  id uuid PRIMARY KEY,
  occurred_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  action text NOT NULL CHECK (action IN ('access.granted', 'access.denied', 'auth.login_failed')),
  request_id uuid NOT NULL,
  actor_id uuid,
  resource_id uuid,
  permission text CHECK (permission IN ('public.read', 'interaction.create', 'profile.readSelf', 'profile.updateSelf',
    'work.manage', 'work.submit', 'team.read', 'team.manage', 'review.score',
    'admin.access', 'admin.sensitive', 'admin.dangerous')),
  outcome text NOT NULL,
  retention_class text NOT NULL DEFAULT 'security_6m' CHECK (retention_class = 'security_6m'),
  expires_at timestamptz NOT NULL DEFAULT (CURRENT_TIMESTAMP + interval '6 months'),
  CHECK (expires_at > occurred_at),
  CHECK ((action = 'access.granted' AND outcome = 'success') OR
    (action IN ('access.denied', 'auth.login_failed') AND outcome = 'failure')),
  CHECK ((action = 'auth.login_failed' AND permission IS NULL) OR
    (action IN ('access.granted', 'access.denied') AND permission IS NOT NULL))
);
CREATE INDEX security_events_expiry_idx ON platform.security_events (expires_at);
CREATE INDEX security_events_request_idx ON platform.security_events (request_id);
REVOKE ALL ON platform.security_events FROM PUBLIC;
