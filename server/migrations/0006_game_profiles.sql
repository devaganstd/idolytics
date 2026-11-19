-- v0.3.0: game profiles (docs/09-game-profiles.md). Plays replace levels, plus dimensions, tracks and flows.

-- level_days becomes play_days: a play has a kind (level, match, run, round), a mode and a difficulty,
-- and can end in a draw or an abandon. level_* events are rolled up as plays of kind level.
CREATE TABLE play_days (
  project_id TEXT NOT NULL,
  day TEXT NOT NULL,
  kind TEXT NOT NULL,
  level TEXT NOT NULL,
  mode TEXT NOT NULL,
  difficulty TEXT NOT NULL,
  version TEXT NOT NULL,
  platform TEXT NOT NULL,
  starts INTEGER NOT NULL DEFAULT 0,
  players INTEGER NOT NULL DEFAULT 0,
  wins INTEGER NOT NULL DEFAULT 0,
  fails INTEGER NOT NULL DEFAULT 0,
  quits INTEGER NOT NULL DEFAULT 0,
  draws INTEGER NOT NULL DEFAULT 0,
  abandons INTEGER NOT NULL DEFAULT 0,
  first_starts INTEGER NOT NULL DEFAULT 0,
  first_try_wins INTEGER NOT NULL DEFAULT 0,
  duration_sum INTEGER NOT NULL DEFAULT 0,
  duration_n INTEGER NOT NULL DEFAULT 0,
  stars_sum REAL NOT NULL DEFAULT 0,
  stars_n INTEGER NOT NULL DEFAULT 0,
  moves_left_sum REAL NOT NULL DEFAULT 0,
  moves_left_n INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (project_id, day, kind, level, mode, difficulty, version, platform)
) WITHOUT ROWID;

INSERT INTO play_days (project_id, day, kind, level, mode, difficulty, version, platform, starts, players, wins, fails, quits,
  first_starts, first_try_wins, duration_sum, duration_n, stars_sum, stars_n, moves_left_sum, moves_left_n)
SELECT project_id, day, 'level', level, '', '', version, platform, starts, players, wins, fails, quits,
  first_starts, first_try_wins, duration_sum, duration_n, stars_sum, stars_n, moves_left_sum, moves_left_n FROM level_days;

DROP TABLE level_days;

-- Plays by a profile dimension value (a props key). dim '' holds every play of the kind, for pick rates.
-- A multi-value dimension counts the play once per value. At most 200 values per dimension; the rest are "other".
CREATE TABLE dim_days (
  project_id TEXT NOT NULL,
  day TEXT NOT NULL,
  dim TEXT NOT NULL,
  value TEXT NOT NULL,
  kind TEXT NOT NULL,
  version TEXT NOT NULL,
  platform TEXT NOT NULL,
  plays INTEGER NOT NULL DEFAULT 0,
  players INTEGER NOT NULL DEFAULT 0,
  wins INTEGER NOT NULL DEFAULT 0,
  losses INTEGER NOT NULL DEFAULT 0,
  draws INTEGER NOT NULL DEFAULT 0,
  score_sum REAL NOT NULL DEFAULT 0,
  score_n INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (project_id, day, dim, value, kind, version, platform)
) WITHOUT ROWID;

-- Progression tracks bucketed by the profile milestones. devices: devices whose highest value that day is in
-- the bucket. reached: devices that first reached the milestone that day; reach_days sums their days since install.
CREATE TABLE track_days (
  project_id TEXT NOT NULL,
  day TEXT NOT NULL,
  track TEXT NOT NULL,
  bucket TEXT NOT NULL,
  version TEXT NOT NULL,
  platform TEXT NOT NULL,
  devices INTEGER NOT NULL DEFAULT 0,
  reached INTEGER NOT NULL DEFAULT 0,
  reach_days INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (project_id, day, track, bucket, version, platform)
) WITHOUT ROWID;

-- Flow steps: step events, and tutorial_* events as the flow "tutorial".
CREATE TABLE step_days (
  project_id TEXT NOT NULL,
  day TEXT NOT NULL,
  flow TEXT NOT NULL,
  step INTEGER NOT NULL,
  version TEXT NOT NULL,
  platform TEXT NOT NULL,
  devices INTEGER NOT NULL DEFAULT 0,
  duration_sum INTEGER NOT NULL DEFAULT 0,
  duration_n INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (project_id, day, flow, step, version, platform)
) WITHOUT ROWID;

-- The game profile JSON (null: use the detected preset), the detected preset, and the known values per dimension.
ALTER TABLE projects ADD COLUMN profile TEXT;
ALTER TABLE projects ADD COLUMN profile_detected TEXT;
ALTER TABLE projects ADD COLUMN dim_values TEXT;
-- Each device's highest value per track, so a milestone is reached once.
ALTER TABLE devices ADD COLUMN tracks TEXT;

-- Fill the new tables from raw rows: a zone mismatch makes the next cron run rebuild the last 89 days.
UPDATE projects SET rollup_tz = rollup_tz + 100000;
