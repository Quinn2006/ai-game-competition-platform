CREATE TABLE platform.works (
  id uuid PRIMARY KEY, owner_id uuid REFERENCES platform.accounts,
  title text NOT NULL, published_version uuid,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE platform.game_versions (
  id uuid PRIMARY KEY, work_id uuid NOT NULL REFERENCES platform.works,
  status text NOT NULL CHECK (status IN ('pending','reviewing','approved','changes','rejected')),
  withdrawn boolean NOT NULL DEFAULT false, revoked boolean NOT NULL DEFAULT false,
  digest text NOT NULL, metadata jsonb NOT NULL, findings jsonb NOT NULL,
  scan_status text NOT NULL CHECK (scan_status IN ('clean','infected','error')),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
ALTER TABLE platform.works ADD CONSTRAINT published_version_fk FOREIGN KEY (published_version) REFERENCES platform.game_versions;
CREATE TABLE platform.upload_events (
  id uuid PRIMARY KEY, work_id uuid REFERENCES platform.works, version_id uuid REFERENCES platform.game_versions,
  actor_id uuid, action text NOT NULL, detail jsonb NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX versions_work_idx ON platform.game_versions(work_id);
CREATE INDEX upload_events_work_idx ON platform.upload_events(work_id);
CREATE FUNCTION platform.immutable_game_payload() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.digest <> OLD.digest OR NEW.metadata <> OLD.metadata OR NEW.work_id <> OLD.work_id OR NEW.findings <> OLD.findings OR NEW.scan_status <> OLD.scan_status THEN
    RAISE EXCEPTION 'Game version payload is immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER immutable_game_payload BEFORE UPDATE ON platform.game_versions FOR EACH ROW EXECUTE FUNCTION platform.immutable_game_payload();
