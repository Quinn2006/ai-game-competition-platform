DO $$ BEGIN
  IF EXISTS(SELECT FROM platform.work_profiles) OR EXISTS(SELECT FROM platform.discovery_teams)
    OR EXISTS(SELECT FROM platform.discovery_metrics) OR EXISTS(SELECT FROM platform.search_history)
    OR EXISTS(SELECT FROM platform.search_counts) OR EXISTS(SELECT FROM platform.discovery_events) THEN
    RAISE EXCEPTION 'discovery data is not empty; rollback refused';
  END IF;
END $$;
DROP TABLE platform.discovery_events,platform.search_counts,platform.search_history,
  platform.discovery_settings,platform.discovery_metrics,platform.work_profiles,platform.discovery_teams;
