ALTER TABLE platform.notification_archives ADD COLUMN contest_id uuid REFERENCES platform.competitions;
ALTER TABLE platform.support_chats ADD COLUMN provider_key uuid;
ALTER TABLE platform.support_chats ADD COLUMN pending boolean NOT NULL DEFAULT false;
CREATE TABLE platform.support_complaints (
 id uuid PRIMARY KEY, account_id uuid REFERENCES platform.accounts, question text NOT NULL, answer text NOT NULL,
 reason text NOT NULL, resolution text, created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP, closed_at timestamptz
);
CREATE TABLE platform.support_deletions (
 provider_key uuid PRIMARY KEY, requested_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 attempts integer NOT NULL DEFAULT 0, next_attempt timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
