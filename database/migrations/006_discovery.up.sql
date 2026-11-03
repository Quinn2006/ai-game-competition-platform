-- Requires phase 3 works/game_versions before applying to an application database.
CREATE TABLE platform.discovery_teams (
  id uuid PRIMARY KEY, name text NOT NULL, bio text NOT NULL DEFAULT '',
  members jsonb NOT NULL DEFAULT '[]'
);
CREATE TABLE platform.work_profiles (
  work_id uuid PRIMARY KEY REFERENCES platform.works,
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 100),
  summary text NOT NULL CHECK (char_length(summary) BETWEEN 1 AND 10000),
  instructions text NOT NULL CHECK (char_length(instructions) BETWEEN 1 AND 5000),
  category text NOT NULL CHECK (category IN ('动作','射击','益智','冒险','体育','休闲','模拟经营','其他')),
  tags text[] NOT NULL DEFAULT '{}', cover text NOT NULL DEFAULT '',
  team_id uuid REFERENCES platform.discovery_teams,
  featured boolean NOT NULL DEFAULT false,
  CHECK (cardinality(tags)<=10)
);
CREATE TABLE platform.discovery_metrics (
  work_id uuid PRIMARY KEY REFERENCES platform.works,
  likes bigint NOT NULL DEFAULT 0 CHECK(likes>=0),
  plays bigint NOT NULL DEFAULT 0 CHECK(plays>=0),
  popularity double precision CHECK(popularity>=0 AND popularity<'Infinity'::float8),
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE platform.discovery_settings (
  id boolean PRIMARY KEY DEFAULT true CHECK(id), batch_size integer NOT NULL CHECK(batch_size BETWEEN 1 AND 60),
  blocked_terms text[] NOT NULL DEFAULT '{}'
);
INSERT INTO platform.discovery_settings(id,batch_size) VALUES(true,12);
CREATE TABLE platform.search_history (
  account_id uuid NOT NULL REFERENCES platform.accounts, term text NOT NULL,
  searched_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(account_id,term)
);
CREATE TABLE platform.search_counts (
  day date NOT NULL, term text NOT NULL, count bigint NOT NULL CHECK(count>0), PRIMARY KEY(day,term)
);
CREATE TABLE platform.discovery_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, actor_id uuid NOT NULL,
  action text NOT NULL, work_id uuid, occurred_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX search_history_expiry_idx ON platform.search_history(searched_at);
