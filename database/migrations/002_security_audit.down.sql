DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM platform.security_events) THEN
    RAISE EXCEPTION 'Rollback refused: security audit history is not empty';
  END IF;
END $$;
DROP TABLE platform.security_events;
