DO $$ BEGIN
 IF EXISTS(SELECT FROM platform.community_likes) OR EXISTS(SELECT FROM platform.community_favorites)
 OR EXISTS(SELECT FROM platform.community_comments) OR EXISTS(SELECT FROM platform.play_sessions)
 OR EXISTS(SELECT FROM platform.play_daily) OR EXISTS(SELECT FROM platform.play_aliases)
 OR EXISTS(SELECT FROM platform.community_risks) OR EXISTS(SELECT FROM platform.community_events)
 THEN RAISE EXCEPTION 'Community history is not empty; forward repair required'; END IF;
END $$;
ALTER TABLE platform.discovery_metrics DROP COLUMN duration_ms;
DROP TABLE platform.community_events,platform.community_risks,platform.play_aliases,platform.play_daily,platform.play_sessions,
 platform.community_settings,platform.community_comments,platform.community_favorites,platform.community_likes;
