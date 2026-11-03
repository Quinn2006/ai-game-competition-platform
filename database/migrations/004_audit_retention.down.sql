DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM platform.audit_holds) THEN
    RAISE EXCEPTION 'Rollback refused: retention holds are not empty';
  END IF;
END $$;
DROP TABLE platform.audit_holds;
