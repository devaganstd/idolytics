-- Dashboard v0.2.1: first try win rate and level detail.

-- level_start events with attempt 1, the denominator of the first try win rate.
ALTER TABLE level_days ADD COLUMN first_starts INTEGER NOT NULL DEFAULT 0;

-- Events sent with a level, other than level_start and level_complete: fails and quits by
-- reason, boosters by booster, continues. detail is props.reason, props.via or props.booster.
CREATE TABLE level_events (
  project_id TEXT NOT NULL,
  day TEXT NOT NULL,
  level TEXT NOT NULL,
  name TEXT NOT NULL,
  detail TEXT NOT NULL,
  version TEXT NOT NULL,
  platform TEXT NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (project_id, day, level, name, detail, version, platform)
) WITHOUT ROWID;

-- Fill the new columns from raw rows: a zone mismatch makes the next cron run rebuild the
-- last 89 days, as after a time zone change. Older days keep first_starts at 0.
UPDATE projects SET rollup_tz = rollup_tz + 100000;
