# 02. Design

Product: idolytics. Licence: server and dashboard AGPL-3.0, SDKs MIT. Status: design, nothing built.

## 1. Tiers

| Tier | Needs | Gives |
|---|---|---|
| 0 | A Cloudflare account (free) or any host with Docker | Collector, storage, dashboard, per level views, retention, sessions, economy, ads as reported by the game |
| 1 | Tier 0 plus a Firebase project with BigQuery export and a service account JSON | AdMob `ad_impression` revenue as Google records it, Crashlytics crash counts, Firebase audience numbers beside idolytics numbers |
| 2 | Tier 1 service account with the Remote Config role | Read and edit Firebase Remote Config values from the dashboard, and filter every chart by the config a player received |

Tier 0 is complete on its own. Tiers 1 and 2 are connectors that add data; they never become a dependency of ingest.

Deploy targets for Tier 0:

1. **Cloudflare** (MVP): a Deploy to Cloudflare button creates one Worker and one D1 database. Collector and dashboard are the same Worker.
2. **Docker Compose** (v1): one container running the same code on Node, with SQLite by default and Postgres as an option.

Both share one codebase through a storage adapter (section 2.3).

## 2. Architecture

```
 Game (Unity SDK / HTTP)                     Browser (admin)
        |  POST /v1/events (write key)              |  GET /  (admin session)
        v                                           v
 +------------------------- Worker or Node --------------------------+
 |  ingest: auth, validate, rate limit, enrich, batch insert         |
 |  rollup: hourly and daily aggregates (cron)                       |
 |  dashboard: server-rendered HTML, inline SVG charts               |
 |  connectors: BigQuery reader (Tier 1), Remote Config (Tier 2)     |
 +--------------------------------+----------------------------------+
                                  |
                       storage adapter (SQL)
                     D1  |  SQLite  |  Postgres
```

### 2.1 Ingest

- `POST /v1/events` takes a batch of up to 100 events, 64 KB body, gzip accepted.
- Steps: check the write key against the project, check the body against the schema (03), drop unknown fields beyond limits, stamp `received_at` and a coarse country from the edge header, insert raw rows in one statement, answer `202` with counts of accepted and rejected events.
- Idempotent: every event carries `event_id` (UUID v4 from the SDK); a retry of the same batch inserts nothing twice (`INSERT OR IGNORE` on `(project_id, event_id)`).
- Clock: the event keeps the device time `client_ts`; the server keeps `received_at`. Durations are computed on the device and sent, never derived from two client timestamps on the server, which is the cause of the negative average duration in the reference dashboard.

### 2.2 Rollups

- A scheduled job every 15 minutes (Cloudflare Cron Trigger, or an interval in the Node process) folds new raw rows into `agg_hourly` and `agg_level_daily`.
- Dashboard queries read aggregates first and touch raw rows only for the last open hour and for drill-downs.
- Raw retention defaults to 90 days, aggregates forever; both configurable. This keeps D1 under its 5 GB free storage.

### 2.3 Storage adapter

One interface with `insertEvents`, `query`, `runRollup`, `migrate`. Implementations: D1, better-sqlite3, Postgres. SQL is written in the subset all three accept; JSON properties are stored as text and read with `json_extract` (SQLite and D1) or `->>` (Postgres) behind a helper.

### 2.4 Dashboard

- Server-rendered HTML with inline SVG charts, no build step, a small script for filters and table sorting. Matches the reference dashboard the owner already reads.
- Pages: Overview, Levels, Level detail, Funnel (tutorial and first levels), Retention, Economy, Ads and IAP, Events explorer, Settings (projects, keys, connectors).
- Filters on every page: date range, app version, platform, country, remote config variant, new versus returning.
- Overview cards: events, play minutes, unique devices, levels played, average highest level, D1, D7.
- Levels table: starts, unique players, clears, fails, quits, clear rate, first try clear rate, average attempts to clear, median and p90 duration, average stars, average moves or throws, continues used, boosters used, ad revenue.

### 2.5 Connectors

- **BigQuery (Tier 1).** The admin pastes a service account JSON with the BigQuery Data Viewer and Job User roles. The key is encrypted at rest with a server secret. A daily job runs fixed, parameterised queries against `analytics_<id>.events_*` for `ad_impression` value by day, app version and level parameter (when the game logs `level` on the Firebase side), and against the Crashlytics export for crash-free users by version. Results land in `ext_daily` and are joined in the dashboard by date and version, never by user, because the two systems do not share an id.
- **Remote Config (Tier 2).** Uses the Firebase Remote Config REST API with the same service account plus the Remote Config Admin role. The dashboard lists parameters and conditions, shows the template version, edits values and publishes with an ETag check. The SDK reports the active config keys and values it received as `rc` on `session_start`, which powers the config filter for every chart.

## 3. Data model

```sql
projects(
  id TEXT PRIMARY KEY,          -- short slug, e.g. ninja-smash
  name TEXT, created_at INTEGER,
  write_key_hash TEXT,          -- SHA-256 of the write key
  settings TEXT                 -- JSON: retention days, allowed origins, currencies
)
admin_users(id, email, password_hash, created_at)
admin_sessions(id, user_id, expires_at)
project_members(project_id, user_id, role)   -- owner, editor, viewer

events(
  project_id TEXT, event_id TEXT,
  name TEXT,                    -- e.g. level_complete
  device_id TEXT, session_id TEXT, user_id TEXT NULL,
  client_ts INTEGER, received_at INTEGER,
  app_version TEXT, platform TEXT, os TEXT, country TEXT,
  level TEXT NULL, attempt INTEGER NULL, duration_ms INTEGER NULL,
  value REAL NULL, currency TEXT NULL,
  props TEXT,                   -- JSON for everything else
  PRIMARY KEY(project_id, event_id)
)
devices(project_id, device_id, first_seen, last_seen, first_version, platform, country)
agg_hourly(project_id, hour, name, app_version, platform, count, devices, value_sum)
agg_level_daily(project_id, day, level, app_version,
  starts, players, completes, fails, quits, first_try_completes,
  duration_sum, duration_n, stars_sum, moves_sum, continues, boosters, ad_revenue)
ext_daily(project_id, day, app_version, source, metric, value)   -- Tier 1
connectors(project_id, kind, encrypted_secret, settings, last_run, last_error)
```

The common game fields (`level`, `attempt`, `duration_ms`, `value`, `currency`) are columns because every level and economy query filters or sums them. Everything else stays in `props`.

Retention needs the days on which each device was active. Scanning raw events for that is too costly, so the rollup fills a narrow `device_days(project_id, device_id, day)` table, and D1 to D30 are read from it against `devices.first_seen`.

## 4. Security

### 4.1 Projects and keys

- One server holds many projects; every row carries `project_id` and every query is scoped by it in the storage adapter, not in callers.
- **Write key** (`idl_w_` prefix, 24 random bytes): ships inside the game, allows only `POST /v1/events` for its project. It is public by nature, so it is treated as an identifier with a rate limit, not as a secret. It can be rotated; the old key keeps working for a grace period so shipped builds are not cut off at once.
- **Admin access**: email and password with an HTTP-only session cookie for the dashboard, and an **admin key** (`idl_a_` prefix) for the read API and automation. Admin keys are stored hashed and shown once.
- First run: the deploy sets one `ADMIN_BOOTSTRAP_TOKEN` secret; the first visit uses it to create the owner account and is then disabled.

### 4.2 Rate limits and abuse

- Per write key and per IP: requests per minute and events per day, defaults sized to ten times the project's trailing daily peak, with a floor for new projects. Cloudflare uses the Workers rate limiting binding; Node uses an in-memory token bucket.
- Per device: a cap on events per session (default 2,000) and on custom event names per project (default 200) to stop a bug or an attacker from exploding cardinality.
- Payload validation: names match `^[a-z][a-z0-9_]{0,39}$`, at most 25 properties, string values at most 100 characters, numbers finite, timestamps within 30 days back and 1 day forward of `received_at`.
- Optional origin allow list for WebGL builds, checked on `Origin`, documented as a speed bump rather than a guard.
- Poisoned data is the realistic threat from a public write key. The dashboard can exclude a device, a version or an IP range retroactively, and the rollup respects exclusions.

### 4.3 Server side

- Admin pages require a session; state changing forms carry a CSRF token; responses set a strict Content Security Policy since all scripts are first party.
- Connector secrets are encrypted with AES-GCM using a key from the deploy secret store; they are never sent back to the browser.

## 5. Privacy

- **Role.** Whoever deploys idolytics is the data controller and, for most games, the only processor. idolytics the project receives nothing: there is no telemetry home.
- **Identifiers.** The SDK creates a random `device_id` (UUID v4) on first launch and stores it in app storage. It does not read the advertising id, Android id, IDFV or IDFA. Uninstall resets it. `user_id` is optional and set only by the game.
- **IP addresses.** Used in memory for rate limiting and country lookup, never stored.
- **Personal data.** None by default. The docs forbid names, emails and free text in properties, and the server can reject property keys on a deny list (`email`, `name`, `phone`).
- **Consent.** The SDK starts disabled when the game sets `requireConsent`; `Idolytics.SetConsent(true)` starts sending, `false` stops and deletes the queue. The game decides when consent is needed (GDPR, UK, COPPA audiences).
- **Deletion and export.** An admin endpoint deletes or exports all rows for a `device_id`; the SDK exposes the id so a game can show it in a support screen.
- **Children.** Games directed at children must not set `user_id` and should keep country granularity; the docs carry a section on Families policy.
- **Play data safety.** The docs give a filled example: Device or other identifiers (collected, not shared, analytics), App interactions (collected, not shared, analytics), Crash logs only if Tier 1 Crashlytics is used through Firebase, data encrypted in transit, deletion on request available.
- **Privacy policy.** The docs carry a template paragraph naming the self-hosted analytics endpoint, the data kinds, retention and the deletion route.
