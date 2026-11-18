# 05. Documentation plan

The documentation site is built from Markdown in the `docs/` folder of the product repository with a static generator (Astro Starlight or VitePress, decided when the repository is created) and deployed to Cloudflare Pages. Every page states which version it applies to.

## 1. Site structure

```
Quickstart
  Deploy to Cloudflare
  Deploy with Docker
  Unity in five minutes
  Your first dashboard
Concepts
  Projects and keys
  Sessions and devices
  Levels, attempts and results
  Rollups and data freshness
  Tiers and connectors
Event reference
  Envelope and limits
  Session and lifecycle
  Levels
  Continues and boosters
  Items, upgrades and currency
  Ads and in-app purchases
  Tutorial and rating
  Custom events
  GA4 mapping table
SDK reference
  Unity: install, settings asset, API, offline queue, consent, Firebase sink, WebGL notes
  JavaScript (v1)
  Godot (community)
HTTP API reference
  POST /v1/events
  Read API (admin key)
  Errors and rate limits
  OpenAPI file
Self-hosting
  Cloudflare: limits, custom domain, upgrades
  Docker: SQLite, Postgres, backups, TLS
  Configuration reference
  Upgrading and migrations
Connectors
  BigQuery (Firebase, AdMob, Crashlytics)
  Remote Config
Privacy
  You are the data controller
  What the SDK collects
  Consent
  Deletion and export
  Google Play data safety answers
  App Store privacy labels
  Privacy policy template
  Children and Families policy
Contributing
  Development setup
  Architecture
  Code style and tests
  Adding a storage adapter
  Adding an SDK
  Releases
```

## 2. Draft README.md

```markdown
# idolytics

Open source game analytics you host yourself. See where players clear, fail and quit every level.

- Deploy free on your own Cloudflare account in one click, or run it with Docker.
- Unity package by Git URL: Android, iOS, WebGL, desktop.
- Level first: attempts, duration, moves, stars, continues, boosters, ad revenue per level.
- Firebase optional: connect BigQuery for AdMob revenue and Crashlytics, and edit Remote Config from the dashboard.
- Plain HTTP JSON API for any other engine.

[Deploy to Cloudflare button]

## Quickstart

1. Press Deploy to Cloudflare and open the URL it gives you.
2. Create the owner account and a project. Copy the write key.
3. In Unity, add `https://github.com/<org>/idolytics-unity.git` in the Package Manager.
4. Create a idolytics Settings asset, paste the URL and the key.
5. Call `Idolytics.LevelStart("1")` and `Idolytics.LevelComplete("1")`. Press Play.

Full guide: <docs site>/quickstart

## What it shows

Overview, per level table and detail, onboarding funnel, retention D1 to D30, economy, ads and IAP, events explorer. Every chart filters by version, platform, country and remote config.

## Privacy

idolytics sends nothing to its authors. The SDK uses a random install id and no advertising ids. You are the data controller for what your game sends. See <docs site>/privacy.

## Licence

Server and dashboard: AGPL-3.0. SDKs: MIT, so they can ship inside any game.

## Contributing

See CONTRIBUTING.md.
```

## 3. Draft Quickstart page

```markdown
# Quickstart

Ten minutes from nothing to your first level on a dashboard you own.

## Before you start

- A Cloudflare account. The free plan is enough for a game with a few thousand daily players.
- Unity 2021.3 or newer.

## 1. Deploy

Press Deploy to Cloudflare on the repository page. Keep the defaults and press Deploy. When it finishes, copy the Worker URL and the bootstrap token from the deploy log.

## 2. Create the owner account

Open the Worker URL. Enter the bootstrap token, your email and a password.

## 3. Create a project

Press New project, give it a name. Copy the write key now: it is shown once.

## 4. Install the Unity package

Window > Package Manager > + > Add package from git URL:

    https://github.com/<org>/idolytics-unity.git

## 5. Configure

Assets > Create > idolytics > Settings. Paste the Worker URL into Endpoint and the write key into Write Key.

## 6. Send your first level

    using Idolytics;

    Idolytics.LevelStart("1");
    // when the player wins
    Idolytics.LevelComplete("1", moves: 7, stars: 3);
    // when the player loses
    Idolytics.LevelFail("1", reason: "out_of_moves");

Sessions, devices and app versions are tracked automatically.

## 7. See it

Press Play and finish a level. Open the dashboard: Live shows the events, Levels shows level 1 with one start and one result.

## Next

- Event reference: every standard event and its fields.
- Privacy: what to write in your privacy policy and the Play data safety form.
- Connectors: add Firebase revenue and Remote Config.
```
