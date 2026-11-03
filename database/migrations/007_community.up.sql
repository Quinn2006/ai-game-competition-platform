CREATE TABLE platform.community_likes (
 work_id uuid REFERENCES platform.works, account_id uuid REFERENCES platform.accounts,
 active boolean NOT NULL DEFAULT true, PRIMARY KEY(work_id,account_id)
);
CREATE TABLE platform.community_favorites (
 work_id uuid REFERENCES platform.works, account_id uuid REFERENCES platform.accounts,
 created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(work_id,account_id)
);
CREATE TABLE platform.community_comments (
 id uuid PRIMARY KEY, work_id uuid NOT NULL REFERENCES platform.works,
 account_id uuid REFERENCES platform.accounts, parent_id uuid,
 body text NOT NULL, deleted boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(work_id,id), FOREIGN KEY(work_id,parent_id) REFERENCES platform.community_comments(work_id,id)
);
CREATE INDEX ON platform.community_comments(work_id,parent_id,created_at DESC,id);
CREATE INDEX ON platform.community_comments(account_id,created_at);
CREATE TABLE platform.community_settings (id boolean PRIMARY KEY CHECK(id), blocked_words text[] NOT NULL DEFAULT '{}');
INSERT INTO platform.community_settings(id) VALUES(true);
CREATE TABLE platform.play_sessions (
 token_hash text PRIMARY KEY, work_id uuid NOT NULL REFERENCES platform.works,
 identity_hash text NOT NULL, browser_hash text NOT NULL, version_id uuid NOT NULL REFERENCES platform.game_versions,
 started_at timestamptz NOT NULL, updated_at timestamptz NOT NULL, expires_at timestamptz NOT NULL,
 sequence integer NOT NULL DEFAULT 0, elapsed_ms integer NOT NULL DEFAULT 0,
 foreground boolean NOT NULL DEFAULT false, interacted boolean NOT NULL DEFAULT false,
 failed boolean NOT NULL DEFAULT false, counted boolean NOT NULL DEFAULT false
);
CREATE INDEX ON platform.play_sessions(identity_hash,started_at);
CREATE TABLE platform.play_daily (
 work_id uuid REFERENCES platform.works, day date NOT NULL, identity_hash text NOT NULL,
 duration_ms integer NOT NULL, PRIMARY KEY(work_id,day,identity_hash)
);
CREATE TABLE platform.play_aliases (
 browser_hash text NOT NULL, day date NOT NULL, identity_hash text NOT NULL,
 PRIMARY KEY(browser_hash,day)
);
CREATE TABLE platform.community_risks (
 id uuid PRIMARY KEY, work_id uuid REFERENCES platform.works, identity_hash text,
 reason text NOT NULL, created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 resolved_at timestamptz, reviewer_id uuid REFERENCES platform.accounts, resolution text,
 hold_until timestamptz, hold_reason text, hold_by uuid REFERENCES platform.accounts
);
CREATE TABLE platform.community_events (
 id uuid PRIMARY KEY, actor_id uuid REFERENCES platform.accounts, action text NOT NULL,
 target_id uuid, created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
ALTER TABLE platform.discovery_metrics ADD COLUMN duration_ms bigint NOT NULL DEFAULT 0 CHECK(duration_ms>=0);
