-- Refuse to destroy audit history. This rollback is for an empty foundation only.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM platform.audit_events) THEN
    RAISE EXCEPTION 'Rollback refused: audit history is not empty';
  END IF;
END $$;
DROP TABLE platform.audit_events;
DROP TABLE platform.environment_identity;
DROP SCHEMA platform;
