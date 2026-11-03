CREATE TABLE platform.audit_holds (
  id uuid PRIMARY KEY, event_table text NOT NULL CHECK (event_table IN ('audit_events','security_events','identity_events')),
  event_id uuid NOT NULL, reason text NOT NULL CHECK (reason IN ('appeal','security_incident','required_retention')),
  approved_by uuid NOT NULL, review_at timestamptz NOT NULL, released_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX audit_holds_event_idx ON platform.audit_holds(event_table,event_id) WHERE released_at IS NULL;
REVOKE ALL ON platform.audit_holds FROM PUBLIC;
