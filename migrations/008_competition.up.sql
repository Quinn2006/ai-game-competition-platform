CREATE TABLE platform.competitions (
 id uuid PRIMARY KEY, title text NOT NULL,
 registration_start timestamptz NOT NULL, registration_end timestamptz NOT NULL,
 submission_start timestamptz NOT NULL, submission_end timestamptz NOT NULL,
 review_start timestamptz NOT NULL, review_end timestamptz NOT NULL,
 team_limit integer NOT NULL DEFAULT 3 CHECK(team_limit BETWEEN 1 AND 100),
 CHECK(registration_start<registration_end AND submission_start<submission_end
 AND registration_end<=submission_end AND submission_end<=review_start AND review_start<review_end)
);
CREATE TABLE platform.contest_subjects (
 id uuid PRIMARY KEY, contest_id uuid NOT NULL REFERENCES platform.competitions,
 captain_id uuid NOT NULL REFERENCES platform.accounts, name text NOT NULL,
 kind text NOT NULL CHECK(kind IN ('personal','team')), withdrawn boolean NOT NULL DEFAULT false,
 work_id uuid REFERENCES platform.works, version_id uuid REFERENCES platform.game_versions,
 UNIQUE(contest_id,id), UNIQUE(contest_id,work_id)
);
CREATE TABLE platform.contest_members (
 contest_id uuid NOT NULL, subject_id uuid NOT NULL, account_id uuid NOT NULL REFERENCES platform.accounts,
 real_name text NOT NULL, student_number text NOT NULL, verified boolean NOT NULL DEFAULT false,
 PRIMARY KEY(contest_id,account_id), UNIQUE(contest_id,student_number),
 FOREIGN KEY(contest_id,subject_id) REFERENCES platform.contest_subjects(contest_id,id)
);
CREATE TABLE platform.contest_invites (
 token_hash text PRIMARY KEY, subject_id uuid NOT NULL REFERENCES platform.contest_subjects,
 expires_at timestamptz NOT NULL
);
CREATE TABLE platform.contest_changes (
 id uuid PRIMARY KEY, subject_id uuid NOT NULL REFERENCES platform.contest_subjects,
 requester_id uuid NOT NULL REFERENCES platform.accounts,
 kind text NOT NULL CHECK(kind IN ('convert','leave','captain','withdraw')),
 successor_id uuid REFERENCES platform.accounts, accepted boolean NOT NULL DEFAULT false,
 captain_approved boolean NOT NULL DEFAULT false,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','approved','rejected')),
 reason text NOT NULL, decision text, created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE platform.contest_reviews (
 subject_id uuid REFERENCES platform.contest_subjects, judge_id uuid REFERENCES platform.accounts,
 scores jsonb, comment text, submitted_at timestamptz, locked boolean NOT NULL DEFAULT false,
 valid boolean NOT NULL DEFAULT true, supplemental boolean NOT NULL DEFAULT false, PRIMARY KEY(subject_id,judge_id)
);
CREATE TABLE platform.contest_events (
 id uuid PRIMARY KEY, contest_id uuid NOT NULL REFERENCES platform.competitions,
 actor_id uuid REFERENCES platform.accounts, action text NOT NULL, target_id uuid,
 detail jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE platform.contest_signals (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, work_id uuid NOT NULL REFERENCES platform.works,
 kind text NOT NULL CHECK(kind IN ('like','play')), identity_key text NOT NULL,
 active boolean NOT NULL, day date, occurred_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX ON platform.contest_signals(work_id,occurred_at);
CREATE TABLE platform.contest_aliases (browser_hash text NOT NULL,day date NOT NULL,identity_hash text NOT NULL,PRIMARY KEY(browser_hash,day));
CREATE FUNCTION platform.capture_contest_alias() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 INSERT INTO platform.contest_aliases VALUES(NEW.browser_hash,NEW.day,NEW.identity_hash) ON CONFLICT DO NOTHING; RETURN NEW;
END $$;
CREATE TRIGGER contest_alias AFTER INSERT ON platform.play_aliases FOR EACH ROW EXECUTE FUNCTION platform.capture_contest_alias();
CREATE FUNCTION platform.capture_contest_signal() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_TABLE_NAME='community_likes' THEN
  IF TG_OP='INSERT' OR OLD.active IS DISTINCT FROM NEW.active THEN
   INSERT INTO platform.contest_signals(work_id,kind,identity_key,active) VALUES(NEW.work_id,'like',NEW.account_id::text,NEW.active);
  END IF;
 ELSE
  INSERT INTO platform.contest_signals(work_id,kind,identity_key,active,day) VALUES(NEW.work_id,'play',NEW.identity_hash,true,NEW.day);
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER contest_like AFTER INSERT OR UPDATE ON platform.community_likes FOR EACH ROW EXECUTE FUNCTION platform.capture_contest_signal();
CREATE TRIGGER contest_play AFTER INSERT ON platform.play_daily FOR EACH ROW EXECUTE FUNCTION platform.capture_contest_signal();
CREATE TABLE platform.contest_exclusions (
 contest_id uuid REFERENCES platform.competitions, work_id uuid REFERENCES platform.works,
 reason text NOT NULL, actor_id uuid NOT NULL REFERENCES platform.accounts,
 PRIMARY KEY(contest_id,work_id)
);
CREATE TABLE platform.contest_results (
 id uuid PRIMARY KEY, contest_id uuid NOT NULL REFERENCES platform.competitions,
 version integer NOT NULL, cutoff timestamptz NOT NULL, kind text NOT NULL CHECK(kind IN ('daily','final')),
 rule_version text NOT NULL, entries jsonb NOT NULL, evidence jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 published_at timestamptz, published_by uuid REFERENCES platform.accounts, publish_reason text,
 UNIQUE(contest_id,kind,version)
);
CREATE UNIQUE INDEX contest_daily_once ON platform.contest_results(contest_id,cutoff) WHERE kind='daily';
CREATE FUNCTION platform.immutable_contest_result() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF OLD.entries IS DISTINCT FROM NEW.entries OR OLD.evidence IS DISTINCT FROM NEW.evidence OR OLD.cutoff IS DISTINCT FROM NEW.cutoff
 OR OLD.contest_id IS DISTINCT FROM NEW.contest_id OR OLD.rule_version IS DISTINCT FROM NEW.rule_version
 OR OLD.kind IS DISTINCT FROM NEW.kind OR OLD.version IS DISTINCT FROM NEW.version OR OLD.published_at IS NOT NULL THEN
 RAISE EXCEPTION 'Result evidence is immutable'; END IF; RETURN NEW;
END $$;
CREATE TRIGGER immutable_contest_result BEFORE UPDATE ON platform.contest_results FOR EACH ROW EXECUTE FUNCTION platform.immutable_contest_result();
CREATE TABLE platform.contest_appeals (
 id uuid PRIMARY KEY, result_id uuid NOT NULL REFERENCES platform.contest_results,
 subject_id uuid NOT NULL REFERENCES platform.contest_subjects, account_id uuid NOT NULL REFERENCES platform.accounts,
 kind text NOT NULL CHECK(kind IN ('score_calculation','program','procedure')), body text NOT NULL,
 resolution text, resolved_at timestamptz, created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE platform.contest_awards (
 result_id uuid REFERENCES platform.contest_results, subject_id uuid REFERENCES platform.contest_subjects,
 name text NOT NULL, PRIMARY KEY(result_id,subject_id,name)
);
ALTER TABLE platform.competitions ADD COLUMN archived_at timestamptz;
CREATE TABLE platform.ranking_deltas(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,work_id uuid NOT NULL REFERENCES platform.works,likes bigint NOT NULL,plays bigint NOT NULL,occurred_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP);
INSERT INTO platform.ranking_deltas(work_id,likes,plays) SELECT work_id,likes,plays FROM platform.discovery_metrics;
CREATE FUNCTION platform.capture_ranking_delta() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 INSERT INTO platform.ranking_deltas(work_id,likes,plays) VALUES(NEW.work_id,NEW.likes-CASE WHEN TG_OP='INSERT' THEN 0 ELSE OLD.likes END,NEW.plays-CASE WHEN TG_OP='INSERT' THEN 0 ELSE OLD.plays END);RETURN NEW;
END $$;
CREATE TRIGGER ranking_delta AFTER INSERT OR UPDATE OF likes,plays ON platform.discovery_metrics FOR EACH ROW EXECUTE FUNCTION platform.capture_ranking_delta();
CREATE TABLE platform.global_rankings(cutoff timestamptz PRIMARY KEY,entries jsonb NOT NULL,rule_version text NOT NULL);
REVOKE ALL ON platform.ranking_deltas,platform.global_rankings FROM PUBLIC;
CREATE FUNCTION platform.sync_contest_team() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE sid uuid; BEGIN
 IF TG_TABLE_NAME='contest_members' THEN sid=COALESCE(NEW.subject_id,OLD.subject_id); ELSE sid=COALESCE(NEW.id,OLD.id); END IF;
 INSERT INTO platform.discovery_teams(id,name,members)
 SELECT s.id,s.name,COALESCE((SELECT jsonb_agg(jsonb_build_object('nickname',a.nickname) ORDER BY a.id) FROM platform.contest_members m JOIN platform.accounts a ON a.id=m.account_id WHERE m.subject_id=s.id),'[]')
 FROM platform.contest_subjects s WHERE s.id=sid AND s.kind='team'
 ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,members=EXCLUDED.members;
 UPDATE platform.work_profiles p SET team_id=s.id FROM platform.contest_subjects s WHERE s.id=sid AND s.work_id=p.work_id AND s.kind='team';
 RETURN COALESCE(NEW,OLD);
END $$;
CREATE TRIGGER sync_contest_team_members AFTER INSERT OR UPDATE OR DELETE ON platform.contest_members FOR EACH ROW EXECUTE FUNCTION platform.sync_contest_team();
CREATE TRIGGER sync_contest_team_subject AFTER INSERT OR UPDATE ON platform.contest_subjects FOR EACH ROW EXECUTE FUNCTION platform.sync_contest_team();
ALTER TABLE platform.contest_subjects ALTER COLUMN captain_id DROP NOT NULL;
CREATE FUNCTION platform.contest_closed_at(cid uuid) RETURNS timestamptz LANGUAGE sql STABLE AS $$
 SELECT CASE WHEN EXISTS(SELECT 1 FROM platform.contest_appeals a JOIN platform.contest_results r ON r.id=a.result_id WHERE r.contest_id=cid AND a.resolved_at IS NULL)
 THEN NULL ELSE GREATEST((SELECT max(published_at) FROM platform.contest_results WHERE contest_id=cid),
 (SELECT max(a.resolved_at) FROM platform.contest_appeals a JOIN platform.contest_results r ON r.id=a.result_id WHERE r.contest_id=cid)) END
$$;
CREATE OR REPLACE FUNCTION platform.immutable_contest_result() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.evidence='{}'::jsonb AND OLD.evidence<>'{}'::jsonb
 AND (to_jsonb(NEW)-'evidence')=(to_jsonb(OLD)-'evidence')
 AND platform.contest_closed_at(OLD.contest_id)<CURRENT_TIMESTAMP-interval '1 year' THEN RETURN NEW; END IF;
 IF OLD.entries IS DISTINCT FROM NEW.entries OR OLD.evidence IS DISTINCT FROM NEW.evidence OR OLD.cutoff IS DISTINCT FROM NEW.cutoff
 OR OLD.contest_id IS DISTINCT FROM NEW.contest_id OR OLD.rule_version IS DISTINCT FROM NEW.rule_version
 OR OLD.kind IS DISTINCT FROM NEW.kind OR OLD.version IS DISTINCT FROM NEW.version OR OLD.published_at IS NOT NULL THEN
 RAISE EXCEPTION 'Result evidence is immutable'; END IF; RETURN NEW;
END $$;
REVOKE ALL ON platform.contest_aliases,platform.contest_signals,platform.contest_exclusions,platform.contest_results,platform.contest_appeals,platform.contest_awards FROM PUBLIC;
REVOKE ALL ON platform.competitions,platform.contest_subjects,platform.contest_members,
 platform.contest_invites,platform.contest_changes,platform.contest_reviews,platform.contest_events FROM PUBLIC;
