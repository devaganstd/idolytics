-- v0.3.1: idle module and open gaps (docs/10-v0.3.1.md). Additions only; no rebuild.

-- play_end result "prestige": a completed run, not a win.
ALTER TABLE play_days ADD COLUMN prestiges INTEGER NOT NULL DEFAULT 0;

-- tutorial_skip: a skip at its step in the flow "tutorial".
ALTER TABLE step_days ADD COLUMN skips INTEGER NOT NULL DEFAULT 0;

-- offline_reward: duration_ms summed, for the average time offline.
ALTER TABLE econ_days ADD COLUMN duration_sum INTEGER NOT NULL DEFAULT 0;

-- Sessions by the gap since the device's previous session (session_start props.since_last_ms).
-- bucket: <1h, 1-4h, 4-12h, 12-24h, 24h+.
CREATE TABLE gap_days (
  project_id TEXT NOT NULL,
  day TEXT NOT NULL,
  bucket TEXT NOT NULL,
  version TEXT NOT NULL,
  platform TEXT NOT NULL,
  sessions INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (project_id, day, bucket, version, platform)
) WITHOUT ROWID;

-- The day the preset was last detected; detection reruns daily until a profile is saved.
ALTER TABLE projects ADD COLUMN detected_on TEXT;
-- Tracks, play props keys (with up to 21 distinct values) and flows seen lately, for the Settings form.
ALTER TABLE projects ADD COLUMN seen_keys TEXT;
