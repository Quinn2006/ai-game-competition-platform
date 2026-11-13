-- Durable deletion/revocation evidence, independent of expiring audit events.
CREATE TABLE platform.recovery_ledger (
 kind text NOT NULL CHECK(kind IN ('account','chat','version','work','hidden')),
 id uuid NOT NULL, occurred_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(kind,id)
);
CREATE FUNCTION platform.record_recovery_tombstone() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,platform AS $$
DECLARE k text; target uuid;
BEGIN
 k:=TG_ARGV[0];
 IF k='account' THEN
   IF NEW.status <> 'deleted' THEN RETURN NEW; END IF;
   target:=NEW.id;
 ELSIF k='version' THEN
   IF NOT NEW.revoked AND NOT NEW.withdrawn THEN RETURN NEW; END IF;
   target:=NEW.id;
 ELSIF k='hidden' THEN target:=NEW.work_id;
 ELSE target:=OLD.id;
 END IF;
 INSERT INTO platform.recovery_ledger(kind,id) VALUES(k,target) ON CONFLICT DO NOTHING;
 RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER recovery_account AFTER INSERT OR UPDATE OF status ON platform.accounts FOR EACH ROW EXECUTE FUNCTION platform.record_recovery_tombstone('account');
CREATE TRIGGER recovery_chat AFTER DELETE ON platform.support_chats FOR EACH ROW EXECUTE FUNCTION platform.record_recovery_tombstone('chat');
CREATE TRIGGER recovery_version AFTER INSERT OR UPDATE OF revoked,withdrawn ON platform.game_versions FOR EACH ROW EXECUTE FUNCTION platform.record_recovery_tombstone('version');
CREATE TRIGGER recovery_work AFTER DELETE ON platform.works FOR EACH ROW EXECUTE FUNCTION platform.record_recovery_tombstone('work');
CREATE TRIGGER recovery_hidden AFTER INSERT ON platform.operations_hidden FOR EACH ROW EXECUTE FUNCTION platform.record_recovery_tombstone('hidden');
INSERT INTO platform.recovery_ledger(kind,id) SELECT 'account',id FROM platform.accounts WHERE status='deleted';
INSERT INTO platform.recovery_ledger(kind,id) SELECT 'version',id FROM platform.game_versions WHERE revoked OR withdrawn;
INSERT INTO platform.recovery_ledger(kind,id) SELECT 'hidden',work_id FROM platform.operations_hidden;
REVOKE ALL ON platform.recovery_ledger FROM PUBLIC;
REVOKE ALL ON FUNCTION platform.record_recovery_tombstone() FROM PUBLIC;
