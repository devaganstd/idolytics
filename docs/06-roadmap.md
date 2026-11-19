# 06. Roadmap

Each milestone ends with Ninja Smash running on it, because the first adopter is the test.

## 1. Milestones

| Milestone | Scope | Done when |
|---|---|---|
| M0 Repository | Own repository, licences (AGPL server, MIT SDK), CI, schema v1 frozen as JSON Schema, OpenAPI for `POST /v1/events` | Schema and API files pass validation in CI |
| M1 Collector | Cloudflare Worker, D1 migrations, `POST /v1/events` with validation, size limits, dedupe, write key, CORS for WebGL | A curl batch lands; a replayed batch inserts nothing |
| M2 Unity SDK | UPM package, settings asset, Track API, offline queue on disk, batching, retry with backoff, install and session ids, flush on pause and quit, WebGL via `UnityWebRequest`, Ninja Smash sample adapter | The sample adapter sends every Ninja Smash event with `attempt` and `duration_ms` filled; offline play is delivered on reconnect |
| M3 Dashboard MVP | One admin key; daily players and sessions, level funnel (starts, wins, losses, win rate, attempts per success), inferred quits per level, booster use, raw event tail; readable on a phone | Ninja Smash level table matches a hand count on a test session |
| **MVP release (0.1)** | M0 to M3 | Another developer reaches a first event in under 10 minutes following the Quickstart alone |
| 0.2 Hardening | Owner account and bootstrap token, Retention, Live, filters by date, version and platform, rate limiting binding, Deploy to Cloudflare button, consent switch, typed level and economy helpers | Deploy from a clean account works with the button |
| 0.3 Game profiles | Generic play, progression track, dimension and flow model; game profile with presets and detection; Plays, Progress, Content and Flows pages; SDK 0.2.0 helpers and abandon on next launch (`09-game-profiles`) | Ninja Smash numbers unchanged with no game update, and Hex Battle Ground shaped data matches a hand count |
| M4 Economy and ads | Funnel, Economy, Ads and IAP pages, custom event declaration, exclusions | Ninja Smash continue, booster and ad revenue per level visible |
| M5 Docker | Node runtime, SQLite and Postgres adapters, compose file, backups | Same test suite passes on all three adapters |
| M6 Tier 1 | BigQuery connector, encrypted secrets, daily import, Firebase sink in the Unity SDK behind a version define | Ninja Smash AdMob revenue from BigQuery shown beside device reported revenue |
| M7 Tier 2 | Remote Config read, edit, publish with ETag; config filter on every chart | A value changed in the dashboard reaches a Ninja Smash build |
| **v1.0** | M4 to M7, docs site complete, upgrade path between versions, security review | Two outside games in production for a month |

## 2. MVP scope

- Cloudflare deploy only.
- Ingest at `POST /v1/events`, dedupe, validation, size limits, write key, CORS.
- Unity SDK for Android, iOS, WebGL, Editor.
- Standard session and level events; all other events accepted and listed in a raw event tail.
- Dashboard: daily players and sessions, level funnel, inferred quits per level, booster use, raw event tail. No filters yet.
- One admin key per deploy; many projects.
- README Quickstart, event schema page, privacy notes.
- Rate limits, Retention, Live, filters, owner accounts and the Deploy button follow in 0.2.

## 3. Out of scope

- Hosted SaaS run by the project.
- User level profiles, cohorts builder, A/B test engine, push messaging.
- Receipt validation for IAP.
- Session replay, heatmaps.
- Realtime streaming beyond the Live panel.
- SDKs other than Unity before v1 (the HTTP API covers them).
- Attribution and install source matching.
- Crash collection of its own; crashes come from Crashlytics through Tier 1.

## 4. Risks

| Risk | Effect | Mitigation |
|---|---|---|
| D1 free plan limits (100,000 row writes a day, 5 GB) | Ingest errors for a game that grows | Rollups and raw retention; a usage meter on the dashboard warning at 70 per cent; documented move to the 5 USD Workers plan or Docker |
| Public write key abused | Poisoned or inflated data | Rate limits, cardinality caps, exclusions, key rotation with grace period |
| Self-hosters misconfigure privacy | Legal exposure for them, reputation for the project | Privacy by default in the SDK, filled data safety answers, policy template |
| BigQuery and Remote Config APIs change | Tier 1 and 2 break | Connectors isolated, fixed queries tested against a sample export in CI |
| Firebase and idolytics counts disagree | Users distrust both | Join only by date and version, label sources, document why counts differ |
| Cloudflare platform changes | Deploy button or limits change | Docker path in v1 keeps the product portable; storage adapter isolates D1 |
| Name conflict for idolytics | Rename after launch | Trademark and domain search before the first public release |
| Maintainer time (one studio) | Slow fixes | Narrow scope, Ninja Smash as the forcing test, contributor guide from M0 |
| AGPL deters some adopters | Fewer contributors | SDKs MIT so games are never affected; FAQ explaining the split |
