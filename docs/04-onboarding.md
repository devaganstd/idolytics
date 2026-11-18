# 04. Onboarding

Four paths. Tier 0 is the one most adopters take and has a time target; the rest are added when needed.

## 1. Tier 0: own analytics in under 10 minutes

Prerequisites: a Cloudflare account (free plan is enough), a Unity 2021.3 or newer project.

| Step | Action | Time |
|---|---|---|
| 1 | Open the idolytics repository and press **Deploy to Cloudflare**. Sign in, keep the default names, press Deploy. Cloudflare forks the repository, creates the Worker and the D1 database, and runs the migrations. | 2 min |
| 2 | Cloudflare shows the Worker URL, for example `https://idolytics.<account>.workers.dev`. Open it. The setup page asks for the bootstrap token printed in the deploy log and an email and password for the owner account. | 1 min |
| 3 | Create a project: name `My Game`, slug `my-game`. The page shows the write key once and a ready to paste config. | 1 min |
| 4 | In Unity: Window, Package Manager, Add package from git URL: `https://github.com/<org>/idolytics-unity.git`. | 1 min |
| 5 | Assets, Create, idolytics, Settings. Paste the endpoint URL and the write key. Leave "Send in Editor" on. | 1 min |
| 6 | Add three calls to the game: `Idolytics.LevelStart("1")`, `Idolytics.LevelComplete("1", moves: 7, stars: 3)` and `Idolytics.LevelFail("1", reason: "out_of_moves")`. Sessions are automatic. | 2 min |
| 7 | Press Play, start and finish a level. Open the dashboard: the Live panel shows the events within seconds, Levels shows level 1. | 1 min |

Total: about 9 minutes. A custom domain is optional: Workers settings, Domains, add one.

Docker alternative (v1):

```bash
git clone https://github.com/<org>/idolytics && cd idolytics
cp .env.example .env    # set ADMIN_BOOTSTRAP_TOKEN and SECRET_KEY
docker compose up -d    # SQLite in ./data; set DATABASE_URL for Postgres
```

Then continue from step 2 at `http://<host>:8080`, behind a TLS proxy for production.

## 2. Tier 1: Firebase BigQuery connector

Prerequisites: a Firebase project linked to the game, Google Analytics enabled, a Google Cloud billing account or the BigQuery sandbox.

1. Firebase console, Project settings, Integrations, BigQuery, Link. Enable **Google Analytics** export (daily is enough) and, if used, **Crashlytics** export. The first data appears the next day.
2. If the game uses AdMob, link AdMob to Firebase so `ad_impression` with revenue reaches the export.
3. Google Cloud console, IAM, Service accounts, Create `idolytics-reader`. Grant **BigQuery Data Viewer** on the export dataset and **BigQuery Job User** on the project.
4. Keys, Add key, JSON. Download the file.
5. idolytics dashboard, Settings, Connectors, BigQuery. Paste the JSON, pick the dataset (`analytics_<property_id>`), press Test. The test runs one dry run query and reports bytes scanned.
6. Press Connect. The first import runs at once for the last 30 days; after that once a day. Ads and Overview now show Firebase revenue and crash-free users beside idolytics numbers.

Cost note: the fixed queries scan only the needed columns and dates; a small game stays inside the BigQuery free 1 TB of queries a month.

## 3. Tier 2: Remote Config

1. On the same service account, add **Firebase Remote Config Admin** (to edit) or **Firebase Remote Config Viewer** (read only).
2. Dashboard, Settings, Connectors, Remote Config, Enable.
3. The Remote Config page lists parameters, conditions and the published version. Editing a value and pressing Publish sends the change with the template ETag; a conflict with an edit made in the Firebase console is refused and reloaded.
4. In the game, after Firebase Remote Config fetch and activate, call `Idolytics.SetRemoteConfig(dictionary)` once, or turn on the Firebase sink, which does it automatically. Every chart gains a Config filter.

## 4. Custom events

### 4.1 A custom level event

```csharp
Idolytics.Track("level_hint_used", new Props {
    { "level", currentLevel },
    { "hint", "show_target" }
});
```

Carrying `level` links the event to the level detail page.

### 4.2 An upgrade

Use the standard event when it fits:

```csharp
Idolytics.UpgradePurchased(item: "katana_sharpness", tier: 2, cost: 300, currency: "coins");
```

### 4.3 An item

```csharp
Idolytics.ItemAcquired(item: "bomb", type: "booster", quantity: 3, source: "daily_gift");
```

### 4.4 Declaring for nicer charts

Dashboard, Settings, Events, Declare: name `level_hint_used`, label "Hints used", sum property none, group by `hint`. The Events explorer then charts it per day and per level with that label.

Rules from the schema apply: snake case names up to 40 characters, at most 25 properties, no personal data, 200 custom names per project.
