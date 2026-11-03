CREATE TABLE platform.accounts (
  id uuid PRIMARY KEY, email text UNIQUE, password_hash text,
  status text NOT NULL CHECK (status IN ('pending', 'active', 'deleting', 'deleted', 'disabled')),
  nickname text NOT NULL DEFAULT '', bio text NOT NULL DEFAULT '', avatar text NOT NULL DEFAULT '',
  roles text[] NOT NULL DEFAULT '{}',
  mfa_secret text, mfa_pending text, mfa_step bigint NOT NULL DEFAULT -1,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deletion_due timestamptz,
  CHECK (roles <@ ARRAY['admin','judge']::text[]),
  CHECK (status <> 'deleted' OR (email IS NULL AND password_hash IS NULL AND mfa_secret IS NULL))
);
CREATE TABLE platform.sessions (
  token_hash text PRIMARY KEY, account_id uuid NOT NULL REFERENCES platform.accounts,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at timestamptz NOT NULL, setup_only boolean NOT NULL DEFAULT false
);
CREATE INDEX sessions_account_idx ON platform.sessions(account_id);
CREATE TABLE platform.identity_tokens (
  token_hash text PRIMARY KEY, account_id uuid NOT NULL REFERENCES platform.accounts,
  purpose text NOT NULL CHECK (purpose IN ('verify','reset','cancel','revalidate','recovery')),
  action text, resource_id uuid, session_hash text,
  expires_at timestamptz NOT NULL
);
CREATE INDEX identity_tokens_account_idx ON platform.identity_tokens(account_id);
CREATE TABLE platform.auth_limits (
  key_hash text PRIMARY KEY, attempts integer NOT NULL DEFAULT 0,
  expires_at timestamptz NOT NULL
);
CREATE TABLE platform.identity_events (
  id uuid PRIMARY KEY, actor_id uuid, target_id uuid, action text NOT NULL CHECK (action IN
    ('registered','verified','login','login_failed','logout','reset_requested','password_reset',
     'profile_updated','mfa_setup','mfa_enabled','revalidated','sensitive_read',
     'deletion_requested','deletion_cancelled','deletion_finalized','roles_changed','request_failed')),
  request_id uuid NOT NULL, outcome text NOT NULL CHECK (outcome IN ('success','failure')),
  occurred_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at timestamptz NOT NULL DEFAULT (CURRENT_TIMESTAMP + interval '6 months')
);
CREATE INDEX identity_events_expiry_idx ON platform.identity_events(expires_at);
REVOKE ALL ON ALL TABLES IN SCHEMA platform FROM PUBLIC;
