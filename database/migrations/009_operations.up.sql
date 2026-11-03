CREATE TABLE platform.operations_settings (id boolean PRIMARY KEY CHECK(id), notification_days integer NOT NULL DEFAULT 180 CHECK(notification_days BETWEEN 30 AND 180));
INSERT INTO platform.operations_settings(id) VALUES(true);
CREATE TABLE platform.announcements (
 id uuid PRIMARY KEY, title text NOT NULL, body text NOT NULL, image text NOT NULL DEFAULT '',
 importance text NOT NULL CHECK(importance IN ('normal','important','urgent')),
 state text NOT NULL CHECK(state IN ('scheduled','published','withdrawn','expired')),
 pinned boolean NOT NULL DEFAULT false, publish_at timestamptz NOT NULL, expires_at timestamptz,
 revision integer NOT NULL DEFAULT 1, notified_revision integer NOT NULL DEFAULT 0,
 created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CHECK(expires_at IS NULL OR expires_at>publish_at)
);
CREATE TABLE platform.notifications (
 id uuid PRIMARY KEY, account_id uuid NOT NULL REFERENCES platform.accounts, event_key text NOT NULL,
 title text NOT NULL, body text NOT NULL, important boolean NOT NULL DEFAULT false,
 read_at timestamptz, created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(account_id,event_key)
);
CREATE INDEX ON platform.notifications(account_id,created_at DESC);
CREATE TABLE platform.notification_archives (
 id uuid PRIMARY KEY, account_id uuid REFERENCES platform.accounts, event_key text NOT NULL,
 title text NOT NULL, body text NOT NULL, archive_until timestamptz,
 UNIQUE(account_id,event_key)
);
CREATE TABLE platform.notification_mail (
 id uuid PRIMARY KEY REFERENCES platform.notifications ON DELETE CASCADE,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','sent')),
 attempts integer NOT NULL DEFAULT 0, next_attempt timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 delivered_at timestamptz
);
CREATE TABLE platform.support_feedback (
 id uuid PRIMARY KEY, account_id uuid REFERENCES platform.accounts, body text NOT NULL,
 state text NOT NULL DEFAULT 'open' CHECK(state IN ('open','closed')),
 reply text NOT NULL DEFAULT '', created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP, closed_at timestamptz
);
CREATE TABLE platform.support_chats (
 id uuid PRIMARY KEY, account_id uuid REFERENCES platform.accounts,
 question text NOT NULL, answer text NOT NULL, ended_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE platform.operations_events (
 id uuid PRIMARY KEY, actor_id uuid, action text NOT NULL, target_id uuid,
 request_id uuid NOT NULL, detail jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE platform.operations_hidden (
 work_id uuid PRIMARY KEY REFERENCES platform.works, version_id uuid REFERENCES platform.game_versions
);
CREATE FUNCTION platform.prevent_hidden_publication() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.published_version IS NOT NULL AND EXISTS(SELECT FROM platform.operations_hidden WHERE work_id=NEW.id) THEN
 RAISE EXCEPTION 'Work is hidden by operations'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER prevent_hidden_publication BEFORE UPDATE OF published_version ON platform.works FOR EACH ROW EXECUTE FUNCTION platform.prevent_hidden_publication();
