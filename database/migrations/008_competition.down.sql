DO $$ BEGIN
 IF EXISTS(SELECT FROM platform.competitions) OR EXISTS(SELECT FROM platform.contest_signals)
 OR EXISTS(SELECT FROM platform.ranking_deltas) OR EXISTS(SELECT FROM platform.global_rankings)
 THEN RAISE EXCEPTION 'Competition history is not empty: forward repair required'; END IF;
END $$;
DROP TRIGGER contest_like ON platform.community_likes;
DROP TRIGGER contest_play ON platform.play_daily;
DROP TRIGGER contest_alias ON platform.play_aliases;
DROP FUNCTION platform.capture_contest_alias();
DROP FUNCTION platform.capture_contest_signal();
DROP TRIGGER ranking_delta ON platform.discovery_metrics;
DROP FUNCTION platform.capture_ranking_delta();
DROP TABLE platform.ranking_deltas,platform.global_rankings;
DROP FUNCTION platform.contest_closed_at(uuid);
DROP TRIGGER sync_contest_team_members ON platform.contest_members;
DROP TRIGGER sync_contest_team_subject ON platform.contest_subjects;
DROP FUNCTION platform.sync_contest_team();
DROP TABLE platform.contest_awards,platform.contest_appeals,platform.contest_results,platform.contest_exclusions,platform.contest_signals,platform.contest_aliases;
DROP FUNCTION platform.immutable_contest_result();
DROP TABLE platform.contest_events,platform.contest_reviews,platform.contest_changes,
 platform.contest_invites,platform.contest_members,platform.contest_subjects,platform.competitions;
