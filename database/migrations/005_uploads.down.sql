DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM platform.works) OR EXISTS (SELECT 1 FROM platform.upload_events) THEN
    RAISE EXCEPTION 'Upload history is not empty; preserve it and use forward repair';
  END IF;
END $$;
ALTER TABLE platform.works DROP CONSTRAINT published_version_fk;
DROP TABLE platform.upload_events;
DROP TABLE platform.game_versions;
DROP FUNCTION platform.immutable_game_payload();
DROP TABLE platform.works;
