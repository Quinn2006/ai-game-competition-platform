DO $$ BEGIN
 IF EXISTS(SELECT FROM platform.support_complaints) OR EXISTS(SELECT FROM platform.support_deletions)
 OR EXISTS(SELECT FROM platform.support_chats WHERE provider_key IS NOT NULL)
 OR EXISTS(SELECT FROM platform.notification_archives WHERE contest_id IS NOT NULL)
 THEN RAISE EXCEPTION 'Support lifecycle data is not empty; forward repair required'; END IF;
END $$;
DROP TABLE platform.support_deletions,platform.support_complaints;
ALTER TABLE platform.support_chats DROP COLUMN provider_key,DROP COLUMN pending;
ALTER TABLE platform.notification_archives DROP COLUMN contest_id;
