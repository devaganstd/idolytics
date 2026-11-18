-- Cut D1 row writes per event from 6 to 2: the table becomes the primary key b-tree
-- (WITHOUT ROWID, so no separate autoindex) and keeps one secondary index, the one every
-- dashboard query uses.
CREATE TABLE events_new (
  project_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  name TEXT NOT NULL,
  device_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  user_id TEXT,
  client_ts INTEGER NOT NULL,
  received_at INTEGER NOT NULL,
  app_version TEXT,
  platform TEXT,
  os TEXT,
  country TEXT,
  level TEXT,
  attempt INTEGER,
  duration_ms INTEGER,
  value REAL,
  currency TEXT,
  props TEXT,
  PRIMARY KEY (project_id, event_id)
) WITHOUT ROWID;

INSERT INTO events_new SELECT project_id, event_id, name, device_id, session_id, user_id, client_ts, received_at,
  app_version, platform, os, country, level, attempt, duration_ms, value, currency, props FROM events;
DROP TABLE events;
ALTER TABLE events_new RENAME TO events;
CREATE INDEX events_by_time ON events (project_id, client_ts);

-- Events accepted per project per UTC day, for the daily cap. One row write per batch.
CREATE TABLE usage (
  project_id TEXT NOT NULL,
  day TEXT NOT NULL,
  events INTEGER NOT NULL,
  PRIMARY KEY (project_id, day)
) WITHOUT ROWID;
