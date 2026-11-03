DO $$ BEGIN
 IF EXISTS(SELECT FROM platform.announcements) OR EXISTS(SELECT FROM platform.notifications)
 OR EXISTS(SELECT FROM platform.notification_archives) OR EXISTS(SELECT FROM platform.support_feedback)
 OR EXISTS(SELECT FROM platform.support_chats) OR EXISTS(SELECT FROM platform.operations_events)
 OR EXISTS(SELECT FROM platform.operations_hidden) THEN
 RAISE EXCEPTION 'Operations history is not empty; forward repair required'; END IF;
END $$;
DROP TRIGGER prevent_hidden_publication ON platform.works;
DROP FUNCTION platform.prevent_hidden_publication();
DROP TABLE platform.operations_hidden,platform.operations_events,platform.support_chats,platform.support_feedback,
 platform.notification_mail,platform.notification_archives,platform.notifications,platform.announcements,platform.operations_settings;
