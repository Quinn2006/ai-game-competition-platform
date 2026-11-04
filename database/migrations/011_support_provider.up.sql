CREATE TABLE platform.support_provider (
 id boolean PRIMARY KEY DEFAULT true CHECK(id),
 endpoint text NOT NULL DEFAULT '', model text NOT NULL DEFAULT '',
 key_cipher text, enabled boolean NOT NULL DEFAULT false,
 updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO platform.support_provider(id) VALUES(true);
REVOKE ALL ON platform.support_provider FROM PUBLIC;
