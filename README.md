# idolytics

Open source game analytics you host yourself. See where players win, lose and quit every level.

- Runs on your own Cloudflare account (Worker plus D1). Each stored event costs 2 D1 row writes, plus 1 per batch. With the SDK's batches of 10 or more events, the free plan's 100,000 row writes a day hold about 45,000 events a day for the whole account. Each project is capped at 20,000 events a day by default (`DAILY_EVENT_CAP`), so lower the cap if several projects share one free account.
- Unity package by Git URL. Android, iOS, WebGL, desktop. No Google account needed.
- Level first: starts, wins, losses, win rate, attempts per win and quits per level.
- Plain HTTP JSON API for any other engine.

Status: 0.2.1. The dashboard reads daily rollups and has a filter bar, an overview, retention cohorts, levels with a progression funnel and level detail, events, and a device page. See [what is not in yet](#not-in-yet).

## Quickstart

About ten minutes from nothing to your first event. You need Node.js 20 or newer, a free Cloudflare account and Unity 2021.3 or newer.

### 1. Deploy the server

```bash
git clone https://github.com/devaganstd/idolytics.git
cd idolytics/server
npm install
npx wrangler login
npx wrangler d1 create idolytics
```

`d1 create` prints a `database_id`. Paste it into `server/wrangler.jsonc` in place of the zeros. Then:

```bash
npx wrangler d1 migrations apply idolytics --remote
npx wrangler deploy
npx wrangler secret put ADMIN_KEY
```

`deploy` prints your server URL, such as `https://idolytics.<you>.workers.dev`. For `ADMIN_KEY`, type a long random string (for example the output of `openssl rand -base64 32`) and keep it in your password manager. It protects the dashboard, which refuses every request until the secret is set.

### 2. Create a project

Open the server URL. The browser asks for a user name and password: type any user name and your `ADMIN_KEY` as the password. Press **New project**, give it an id such as `my-game`, and copy the write key (`idl_w_...`). It is shown once.

### 3. Install the Unity package

Window > Package Manager > + > Add package from git URL:

```
https://github.com/devaganstd/idolytics.git?path=/sdk/unity
```

### 4. Configure

Assets > Create > idolytics > Settings. Name the asset `IdolyticsSettings` and keep it in a `Resources` folder. Set **Endpoint** to the server URL and **Write Key** to the key from step 2.

### 5. Send an event

```csharp
using System.Collections.Generic;
using IdolyticsSdk;

Idolytics.Track("level_start", new Dictionary<string, object> { { "level", "1" }, { "attempt", 1 } });
// when the player wins
Idolytics.Track("level_complete", new Dictionary<string, object>
{
    { "level", "1" }, { "attempt", 1 }, { "duration_ms", 42000L }, { "moves_left", 3 },
});
```

Sessions and the install id are automatic. Press Play, finish a level, wait ten seconds.

### 6. Open the dashboard

Reload the server URL about 15 minutes later. A cron job rolls new events up into daily tables every 15 minutes, and the dashboard reads only those tables, so a page load stays cheap. You see:

- **Overview:** average DAU, new users, sessions, session length, playtime per user, D1 and D7 retention and stickiness, each against the previous period; daily new and returning players; top events; the levels with the most quits.
- **Retention:** install day cohorts from D0 to D30.
- **Levels:** a sortable table of starts, distinct players, wins, fails, quits (inferred), win rate, first try win rate, attempts per win, average duration, and average stars and moves left when the game sends them; a progression funnel of players who started each level. Select a level for its numbers by day and by version, and its fail and quit reasons, boosters and continues.
- **Events:** any event over time, a breakdown by one props key (top 20 values), and the 100 newest raw events, filterable by name and device.
- **Device:** one device's install, its active days and its raw events newest first. A device id in the Events tail links to it.

The filter bar sets the date range (a preset, or custom dates; select a day in the chart to see only that day), the comparison, version, platform, country and new or returning players. Filters live in the URL, so a filtered view can be bookmarked.

The device, event and up to three `key=value` property filters (joined with AND) read raw events, on the Levels, Events and Device pages only. A banner says so, the range is capped at the last 30 days, and days are by arrival time.

Each project has a reporting time zone, set in the page header: UTC by default, or a fixed offset such as UTC+7 (WIB), with no daylight saving. Days in every chart run from midnight to midnight in that zone. Changing it rebuilds the last 90 days in the background. The daily event cap still resets at UTC midnight.

Raw events are deleted 90 days after they arrive. The daily tables are kept.

## Local development

```bash
cd server
npm install
cp .dev.vars.example .dev.vars          # set ADMIN_KEY
npx wrangler d1 migrations apply idolytics --local
npx wrangler dev                        # http://localhost:8787
npm test
```

Create a project on `http://localhost:8787`, then fill it with sample Ninja Smash sessions:

```bash
node scripts/seed.mjs http://localhost:8787 idl_w_yourkey
```

## HTTP API

`POST /v1/events` with `Authorization: Bearer <write key>` and a JSON body of up to 100 events and 64 KB. CORS is open, so WebGL builds on any domain can post. The answer is `202 {"accepted": n, "rejected": n}`; a retried batch is not stored twice. See [docs/event-schema.md](docs/event-schema.md).

## Privacy

idolytics sends nothing to its authors. The SDK uses a random install id and no advertising or device ids, and the server never stores IP addresses. You are the data controller for what your game sends. See [docs/privacy.md](docs/privacy.md) for the Google Play Data safety answers and a privacy policy paragraph.

## Not in yet

Planned for 0.2 and later (see [docs/06-roadmap.md](docs/06-roadmap.md) and [docs/08-dashboard-v0.2.md](docs/08-dashboard-v0.2.md)): owner accounts instead of one admin key, a live view, economy and ads, rate limiting, a Deploy to Cloudflare button, a consent switch, typed helpers such as `Idolytics.LevelStart`, device deletion and export, Docker, and the Firebase BigQuery and Remote Config connectors.

## Repository

- `server/`: the Cloudflare Worker (collector and dashboard). AGPL-3.0.
- `sdk/unity/`: the Unity package. MIT, so it can ship inside any game.
- `docs/`: design documents, event schema and privacy notes.

## Licence

The server and dashboard are under the GNU Affero General Public License v3.0 ([LICENSE](LICENSE)). The Unity SDK in `sdk/unity` is under the MIT License ([sdk/unity/LICENSE.md](sdk/unity/LICENSE.md)).
