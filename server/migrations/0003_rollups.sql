-- Dashboard v0.2 (docs/08-dashboard-v0.2.md): daily rollups built by a cron, so a dashboard
-- load reads rollup rows instead of raw events.

-- Reporting time zone in minutes east of UTC (fixed offset, no DST). rollup_tz is the zone the
-- rollups were built in; when it differs from tz_min the cron rebuilds the last 90 days.
ALTER TABLE projects ADD COLUMN tz_min INTEGER NOT NULL DEFAULT 0;
ALTER TABLE projects ADD COLUMN rollup_tz INTEGER NOT NULL DEFAULT 0;
-- Watermark: the last raw row rolled up, by (received_at, event_id).
ALTER TABLE projects ADD COLUMN wm_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE projects ADD COLUMN wm_id TEXT NOT NULL DEFAULT '';
-- During a rebuild, raw rows received up to rebuild_until with client_ts before rebuild_from
-- are already in the kept rollups and are skipped.
ALTER TABLE projects ADD COLUMN rebuild_from INTEGER;
ALTER TABLE projects ADD COLUMN rebuild_until INTEGER;

-- The cron reads raw rows by arrival time. The dashboard no longer scans raw rows by device
-- time, so the index is swapped instead of added: still 2 row writes per stored event.
DROP INDEX events_by_time;
CREATE INDEX events_by_received ON events (project_id, received_at);

-- One row per install. First values define the retention cohort and its filters.
-- open holds level starts not yet closed, as JSON; open_min is the oldest of them not yet
-- counted as a quit, so the cron finds starts to age out without a scan.
CREATE TABLE devices (
  project_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  first_day TEXT NOT NULL,
  version TEXT NOT NULL,
  platform TEXT NOT NULL,
  country TEXT NOT NULL,
  open TEXT,
  open_min INTEGER,
  PRIMARY KEY (project_id, device_id)
) WITHOUT ROWID;
CREATE INDEX devices_open ON devices (project_id, open_min) WHERE open_min IS NOT NULL;

-- One row per device per active day. seen is JSON: session spans and the event names and
-- levels already counted that day, so distinct counts stay exact across cron runs.
CREATE TABLE device_days (
  project_id TEXT NOT NULL,
  day TEXT NOT NULL,
  device_id TEXT NOT NULL,
  version TEXT NOT NULL,
  platform TEXT NOT NULL,
  country TEXT NOT NULL,
  is_new INTEGER NOT NULL,
  sessions INTEGER NOT NULL,
  playtime_ms INTEGER NOT NULL,
  events INTEGER NOT NULL,
  seen TEXT NOT NULL,
  PRIMARY KEY (project_id, day, device_id)
) WITHOUT ROWID;

-- Retention: devices of a cohort (first day and its first version, platform, country) active on a day.
CREATE TABLE cohort_days (
  project_id TEXT NOT NULL,
  first_day TEXT NOT NULL,
  day TEXT NOT NULL,
  version TEXT NOT NULL,
  platform TEXT NOT NULL,
  country TEXT NOT NULL,
  devices INTEGER NOT NULL,
  PRIMARY KEY (project_id, first_day, day, version, platform, country)
) WITHOUT ROWID;

CREATE TABLE level_days (
  project_id TEXT NOT NULL,
  day TEXT NOT NULL,
  level TEXT NOT NULL,
  version TEXT NOT NULL,
  platform TEXT NOT NULL,
  starts INTEGER NOT NULL DEFAULT 0,
  players INTEGER NOT NULL DEFAULT 0,
  wins INTEGER NOT NULL DEFAULT 0,
  fails INTEGER NOT NULL DEFAULT 0,
  quits INTEGER NOT NULL DEFAULT 0,
  first_try_wins INTEGER NOT NULL DEFAULT 0,
  duration_sum INTEGER NOT NULL DEFAULT 0,
  duration_n INTEGER NOT NULL DEFAULT 0,
  stars_sum REAL NOT NULL DEFAULT 0,
  stars_n INTEGER NOT NULL DEFAULT 0,
  moves_left_sum REAL NOT NULL DEFAULT 0,
  moves_left_n INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (project_id, day, level, version, platform)
) WITHOUT ROWID;

CREATE TABLE event_days (
  project_id TEXT NOT NULL,
  day TEXT NOT NULL,
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  platform TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  devices INTEGER NOT NULL DEFAULT 0,
  value_sum REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (project_id, day, name, version, platform)
) WITHOUT ROWID;
