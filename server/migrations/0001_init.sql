CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  write_key_hash TEXT NOT NULL UNIQUE
);

CREATE TABLE events (
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
);

CREATE INDEX events_by_name_time ON events (project_id, name, client_ts);
CREATE INDEX events_by_level ON events (project_id, level, device_id, session_id);
CREATE INDEX events_by_time ON events (project_id, client_ts);
CREATE INDEX events_by_received ON events (project_id, received_at);
