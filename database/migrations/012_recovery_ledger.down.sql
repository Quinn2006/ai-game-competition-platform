DO $$ BEGIN IF EXISTS(SELECT FROM platform.recovery_ledger) THEN RAISE EXCEPTION 'Recovery evidence cannot be discarded'; END IF; END $$;
DROP TRIGGER recovery_account ON platform.accounts;
DROP TRIGGER recovery_chat ON platform.support_chats;
DROP TRIGGER recovery_version ON platform.game_versions;
DROP TRIGGER recovery_work ON platform.works;
DROP TRIGGER recovery_hidden ON platform.operations_hidden;
DROP FUNCTION platform.record_recovery_tombstone();
DROP TABLE platform.recovery_ledger;
