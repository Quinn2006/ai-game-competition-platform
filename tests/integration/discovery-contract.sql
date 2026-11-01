-- Minimal phase-3 contract fixture, only for isolated phase-4 tests.
-- Not an application migration and not evidence of phase-3 integration.
CREATE TABLE platform.works(id uuid PRIMARY KEY,owner_id uuid REFERENCES platform.accounts,title text NOT NULL,published_version uuid,created_at timestamptz DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE platform.game_versions(id uuid PRIMARY KEY,work_id uuid REFERENCES platform.works,status text NOT NULL,revoked boolean DEFAULT false,withdrawn boolean DEFAULT false,scan_status text NOT NULL,created_at timestamptz DEFAULT CURRENT_TIMESTAMP);
ALTER TABLE platform.works ADD FOREIGN KEY(published_version) REFERENCES platform.game_versions;
