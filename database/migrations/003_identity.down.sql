DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM platform.accounts) OR EXISTS (SELECT 1 FROM platform.identity_events) THEN
    RAISE EXCEPTION 'Rollback refused: identity data is not empty';
  END IF;
END $$;
DROP TABLE platform.identity_events;
DROP TABLE platform.auth_limits;
DROP TABLE platform.identity_tokens;
DROP TABLE platform.sessions;
DROP TABLE platform.accounts;
