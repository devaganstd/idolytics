# 07. MVP plan (0.1, Tier 0)

Status: draft for owner approval, 2026-11-18. Implements the MVP scope in `06-roadmap` (M0 to M3) with the PM decisions of 2026-11-18. Where this plan and `02-design` differ, this plan wins for 0.1.

## Layout

```
LICENSE                 AGPL-3.0 (everything except sdk/)
README.md               pitch, quickstart, privacy, licence split
.gitignore .editorconfig
docs/                   01 to 07, event-schema.md, privacy.md
server/                 Cloudflare Worker (TypeScript) + D1
  wrangler.jsonc  package.json  tsconfig.json  vitest.config.ts
  .dev.vars.example     ADMIN_KEY=change-me
  migrations/0001_init.sql
  src/index.ts          router, CORS, auth
  src/ingest.ts         validate + insert
  src/dashboard.ts      queries + HTML
  src/svg.ts            bar and line chart helpers
  scripts/seed.mjs      posts sample Ninja Smash sessions to a running Worker
  test/*.test.ts
sdk/unity/              UPM package com.idolytics.unity (MIT, own LICENSE.md)
  package.json  Runtime/  Tests/Editor/  Samples~/NinjaSmash/
```

## Decisions in this plan (for approval)

1. **Projects without a UI for accounts.** The dashboard has a "New project" form (admin only). It creates the project and shows the write key once (`idl_w_` + 24 random bytes, stored as SHA-256). Many projects per deploy; the dashboard has a project picker.
2. **Admin auth is HTTP Basic** with any user name and the admin key as password (`ADMIN_KEY` from `wrangler secret`, `.dev.vars` locally). No cookie, no login page, no CSRF surface beyond the one form, which also checks `Origin`. Works on phones. Replaced by owner accounts in 0.2.
3. **Write key** travels in `Authorization: Bearer idl_w_...`. CORS allows any origin for `/v1/events` (POST, OPTIONS, that header and `Content-Type`). No origin allow list in 0.1.
4. **No rollups in 0.1.** The dashboard queries raw `events` with indexes on `(project_id, name, client_ts)` and `(project_id, level)`, last 30 days. Fine for a game the size of Ninja Smash on the free plan; rollups come when a query passes D1 limits.
5. **Inferred quit** = for each `(device_id, session_id, level)`, `max(0, starts - completes - fails - explicit quits)`, counted only when the last start is older than 30 minutes, so a level in progress is not a quit. Labelled "Quits (inferred)".
6. **Win rate** = wins / (wins + losses). **Attempts per success** = starts / wins.
7. **Booster use** = count by day and by `props.booster` of `booster_used`, `booster_bought` and `try_taken`.
8. **Ninja Smash adapter** maps only what the dashboard needs and keeps the rest as custom events under their own names:
   - `level_start` to `level_start` (`attempt` from the game; start time remembered per level).
   - `level_win` to `level_complete` with `attempt`, `duration_ms`, `props.moves_left` from `throws_left`.
   - `level_lose` to `level_fail` with `attempt`, `duration_ms`, `props.targets_left` from `pieces_left`, `props.reason: out_of_moves`.
   - `booster_bought`, `try_taken`, `continue_watched`, `continue_bought`, `try_offer_shown`, `interstitial_shown`, `review_*`, `unlock_shown`, `hard_card_shown`, `home_unlocked`, `save_corrupt` pass through with their parameters.
   - `name_set` is sent with no parameters, always.
   - Note: the game sends 17 names, not 16. `continue_bought` (level, price) was missed by the `Log("` grep because the call spans two lines.
9. **Offline queue** lives in `PlayerPrefs` as JSON, capped at 1,000 events (oldest dropped). `PlayerPrefs` persists on WebGL (IndexedDB) without the file system sync that `persistentDataPath` needs.
10. **Settings asset** is loaded from `Resources/IdolyticsSettings`; `Idolytics.Init(settings)` overrides it.
11. **C# namespace is `IdolyticsSdk`** (decided during the build): a static class `Idolytics` inside a namespace `Idolytics` breaks `Idolytics.Track` in scripts without a namespace, which is most Unity scripts.

## Checklist

### M0 Repository
- [ ] `git init`; first commit is the rename (docs only) after owner approval.
- [ ] `LICENSE` (AGPL-3.0, canonical text from gnu.org), `sdk/unity/LICENSE.md` (MIT), `.gitignore` (node, wrangler, `.dev.vars`, Unity `Library/`), `.editorconfig` (TS 2 spaces, C# 4 spaces, LF).

### M1 Collector (TDD, vitest + `@cloudflare/vitest-pool-workers`)
- [ ] `migrations/0001_init.sql`: `projects(id, name, created_at, write_key_hash)`, `events` per `02-design` section 3 with `level`, `attempt`, `duration_ms`, `value`, `currency` as columns, `PRIMARY KEY(project_id, event_id)`, and the two indexes.
- [ ] Tests first, then code, for `POST /v1/events`:
  - 202 with `{accepted, rejected}` for a valid batch; rows land with columns filled and other fields in `props`.
  - Same batch twice inserts nothing new (`INSERT OR IGNORE`).
  - 401 without or with a wrong write key.
  - 413 over 64 KB; 400 for invalid JSON, a missing `events` array or more than 100 events.
  - Per event rejection (counted, rest accepted): bad name pattern, missing `event_id`/`ts`/`session_id`, `ts` outside 30 days back or 1 day forward, more than 25 props, nested props, non-finite numbers, negative `duration_ms`, string value over 100 characters.
  - Props keys `email`, `name`, `phone` and string values that look like an email are rejected.
  - Names starting with `idl_` are rejected.
  - `OPTIONS` preflight returns the CORS headers.
- [ ] Stored per event: `received_at`, `country` from `request.cf.country`. IP is never stored.

### M3 Dashboard (same Worker, `GET /`, Basic auth)
- [ ] Tests: 401 without the key; 200 with it; the level table matches a hand counted fixture (starts, wins, losses, win rate, attempts per success, inferred quits).
- [ ] One page, mobile first, inline SVG, no script:
  - Daily players (distinct devices) and sessions, last 30 days.
  - Level funnel table: starts, wins, losses, win rate, attempts per success, quits (inferred), with a small bar per level.
  - Quit levels: top levels by inferred quits.
  - Booster use per day and per booster.
  - Raw event tail: last 50 events.
- [ ] New project form and project picker.
- [ ] Read `dataviz` skill before drawing charts.

### M2 Unity SDK (`sdk/unity`, Unity 2021.3+, tested on the installed 6000.3)
- [ ] `IdolyticsSettings` ScriptableObject: endpoint, write key, send in editor, flush interval (10 s), batch size (50).
- [ ] `Idolytics.Track(string name, IDictionary<string, object> props = null)`; reserved props `level`, `attempt`, `duration_ms`, `value`, `currency` are lifted into fields.
- [ ] Install id: random GUID in `PlayerPrefs`. Session id: new at launch and after 30 s in background; `session_start` sent automatically.
- [ ] `EventQueue` (plain C#, no Unity API, EditMode tests first): enqueue, take batch, ack, requeue on failure, cap, serialize and restore.
- [ ] Sender: one `MonoBehaviour` coroutine, `UnityWebRequest` only, no threads; backoff 2 s doubling to 5 min; flush on `OnApplicationPause(true)` and `OnApplicationQuit`.
- [ ] `Samples~/NinjaSmash/IdolyticsAnalyticsService.cs`: a `ServiceDefinition` implementing `IAnalyticsService` as in decision 8, with a header comment on how to install it. It is the sample adapter for other games too.

### Docs
- [ ] README quickstart: `npm i`, `wrangler d1 create`, put the id into `wrangler.jsonc`, `wrangler d1 migrations apply --remote`, `wrangler secret put ADMIN_KEY`, `wrangler deploy`, create project, install package by Git URL, send an event, open dashboard.
- [ ] `docs/event-schema.md`: envelope, limits, standard session and level events, custom events.
- [ ] `docs/privacy.md`: what is collected, Play Data safety answers, privacy policy paragraph.

### Verify
- [ ] `npm test` green.
- [ ] `wrangler dev` with local D1, `scripts/seed.mjs` posts sample sessions, dashboard opened in the browser pane at phone and desktop width.
- [ ] Unity EditMode tests run in batch mode on 6000.3; a play mode send against `wrangler dev` from the Editor.
- [ ] `caveman:cavecrew-reviewer` on the diff before each commit request.

## Left out of 0.1

Rollups and raw retention, gzip bodies, rate limiting, write key rotation, origin allow list, consent switch, owner accounts, retention charts, Live panel, filters, Deploy to Cloudflare button, Docker, typed helpers such as `Idolytics.LevelStart`, device deletion and export endpoint, Firebase sink, Tier 1 and 2.

## Not verifiable in this session

A real deploy to Cloudflare (owner runs it), a WebGL build sending from a browser portal, and Android or iOS devices.
