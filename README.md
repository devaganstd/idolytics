# idolytics

Open source game analytics you host yourself. See where players win, lose and quit every level.

- Runs on your own Cloudflare account (Worker plus D1). Each stored event costs 2 D1 row writes, plus 1 per batch. With the SDK's batches of 10 or more events, the free plan's 100,000 row writes a day hold about 45,000 events a day for the whole account. Each project is capped at 20,000 events a day by default (`DAILY_EVENT_CAP`), so lower the cap if several projects share one free account.
- Unity package by Git URL. Android, iOS, WebGL, desktop. No Google account needed.
- Level first: starts, wins, losses, win rate, attempts per win and quits per level.
- Plain HTTP JSON API for any other engine.

Status: 0.1, the first usable release. See [what is not in 0.1](#not-in-01-yet).

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

Reload the server URL. You see daily players and sessions, the level table, the levels where players quit, booster use and the latest events.

Dates and times show in UTC until you pick a time zone in the page header, such as UTC+7 (WIB). The choice is a fixed offset with no daylight saving, and it is kept in a cookie in your browser. The daily event cap still resets at UTC midnight.

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

## Not in 0.1 yet

Planned for 0.2 and later (see [docs/06-roadmap.md](docs/06-roadmap.md)): owner accounts instead of one admin key, retention, a live view, filters by date, version and platform, rate limiting, a Deploy to Cloudflare button, a consent switch, typed helpers such as `Idolytics.LevelStart`, rollups and raw data retention, device deletion and export, Docker, and the Firebase BigQuery and Remote Config connectors.

## Repository

- `server/`: the Cloudflare Worker (collector and dashboard). AGPL-3.0.
- `sdk/unity/`: the Unity package. MIT, so it can ship inside any game.
- `docs/`: design documents, event schema and privacy notes.

## Licence

The server and dashboard are under the GNU Affero General Public License v3.0 ([LICENSE](LICENSE)). The Unity SDK in `sdk/unity` is under the MIT License ([sdk/unity/LICENSE.md](sdk/unity/LICENSE.md)).
