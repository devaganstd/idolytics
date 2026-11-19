-- Dashboard v0.2.2: test and live keys, and the economy and ads rollup.

-- Write keys. A live key writes to project_id; a test key writes to the hidden sibling project
-- "<project_id>~test". projects.write_key_hash is no longer read by ingest.
CREATE TABLE keys (
  key_hash TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  env TEXT NOT NULL CHECK (env IN ('live', 'test'))
) WITHOUT ROWID;

-- Every key already shipped in a build stays a live key.
INSERT INTO keys (key_hash, project_id, env) SELECT write_key_hash, id, 'live' FROM projects;

-- currency_*, booster_*, ad_* and iap_purchase events, plus the Ninja Smash names try_taken,
-- try_offer_shown, interstitial_shown and continue_watched. detail is the source, sink, booster,
-- ad format or product; value_sum sums the event value (an amount, or revenue).
CREATE TABLE econ_days (
  project_id TEXT NOT NULL,
  day TEXT NOT NULL,
  name TEXT NOT NULL,
  currency TEXT NOT NULL,
  detail TEXT NOT NULL,
  version TEXT NOT NULL,
  platform TEXT NOT NULL,
  count INTEGER NOT NULL,
  value_sum REAL NOT NULL,
  PRIMARY KEY (project_id, day, name, currency, detail, version, platform)
) WITHOUT ROWID;

-- Fill econ_days from raw rows: a zone mismatch makes the next cron run rebuild the last 89 days.
UPDATE projects SET rollup_tz = rollup_tz + 100000;

-- When the cron last rolled the project up, so projects that did not fit in a run go first next time.
ALTER TABLE projects ADD COLUMN cron_at INTEGER NOT NULL DEFAULT 0;
