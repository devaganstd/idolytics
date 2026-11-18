# 01. Market research

Product name: **idolytics**. Research date: 2026-11-18. Prices move often; every figure below is as published or reported on that date and must be rechecked before it is quoted publicly.

## 1. Audience

A small studio (one to five people) shipping casual or puzzle games on Unity to Android, iOS and WebGL portals. It needs to know, per level, how many players start, clear, fail and quit, how long a level takes, where players churn, how boosters and continues are used, and how much ad revenue a level earns. It does not have a data engineer and does not want to write SQL against BigQuery to answer those questions.

## 2. Products reviewed

### 2.1 GameAnalytics

- **Open source / self-host:** SDKs are open source; the platform is hosted only.
- **Setup effort:** Low. Unity SDK from the Asset Store, game key and secret key in a settings object.
- **Game features:** Strongest of the group. Progression events with a three part hierarchy (world, stage, level) and Start, Fail, Complete status; resource events for currency sources and sinks; design events for anything custom; funnels and realtime on the free plan.
- **WebGL:** Supported by the Unity SDK; a public feedback thread reports DAU gaps on WebGL that staff were still investigating.
- **Pricing:** Core analytics free; advanced add-ons reported between 29 and 499 USD a month.
- **Weaknesses for a small puzzle developer:** Data lives on a third party platform with no self-host option. The progression hierarchy is fixed at three strings, so attempt number, stars, throws and duration have to be squeezed into a score or into separate design events. Currencies and item types must be whitelisted in advance. Raw export and deeper features sit behind paid tiers.
- Sources: [Event types](https://docs.gameanalytics.com/integrations/api/event-types), [Unity event tracking](https://docs.gameanalytics.com/integrations/sdk/unity/event-tracking), [Asset Store listing](https://assetstore.unity.com/packages/package/1501035), [WebGL DAU thread](https://feedback.gameanalytics.com/web-tool/p/dau-vs-first-event-difference), [pricing summary](https://costbench.com/software/product-analytics/gameanalytics/free-plan/).

### 2.2 Unity Analytics (Unity Gaming Services)

- **Open source / self-host:** Neither.
- **Setup effort:** Low inside Unity; needs a UGS project and consent handling.
- **Game features:** Standard and custom events, funnels such as level progression, SQL Data Explorer.
- **WebGL:** Supported as a Unity platform.
- **Pricing:** Free up to 50,000 MAU, then per MAU from 0.0036 USD; a fair usage guideline of 500 custom events per MAU.
- **Weaknesses:** Lock-in to Unity's platform and pricing decisions, which changed abruptly in 2023 and again to pure MAU metering. Custom events need schema registration in the dashboard before they are accepted. No self-host and no engine neutrality.
- Sources: [MAU based pricing](https://docs.unity.com/ugs/en-us/manual/analytics/manual/mau-based-pricing), [fair usage limits](https://docs.unity.com/ja-jp/analytics/pricing-and-billing/fair-usage-limits), [Google Play data safety for Analytics](https://docs.unity.com/analytics/GoogleDataSafety.html).

### 2.3 Firebase Analytics / Google Analytics 4

- **Open source / self-host:** Neither.
- **Setup effort:** Medium. Firebase project, config files per platform, External Dependency Manager, Gradle resolution in Unity.
- **Game features:** Recommended events such as `level_start`, `level_end`, `level_up`, `post_score`, `earn_virtual_currency`, `spend_virtual_currency`, `tutorial_begin`, `tutorial_complete`, `unlock_achievement`, plus AdMob `ad_impression` with revenue. Per level reporting needs custom definitions or BigQuery.
- **WebGL:** The Firebase Unity SDK targets Android, iOS and desktop; it has no WebGL build, so a WebGL game needs a JavaScript bridge or a third party wrapper.
- **Pricing:** Free; BigQuery export free to set up, queries and storage billed by Google Cloud beyond the sandbox.
- **Weaknesses:** Standard reports are not built for levels; the 25 parameter and 500 event name limits apply; data appears with a delay of hours; the answer to "where do players quit" usually ends in hand written SQL. No WebGL.
- Sources: [Get started with Analytics for Unity](https://firebase.google.com/docs/analytics/unity/get-started?hl=en), [Log events in Unity](https://firebase.google.cn/docs/analytics/unity/events), [GA4 recommended events](https://support.google.com/analytics/answer/9267735), [Firebase on WebGL, third party note](https://docs.pley.com/docs/firebase).

### 2.4 PostHog

- **Open source / self-host:** MIT core; a self-hosted "hobby" deploy on one Docker host.
- **Setup effort:** Cloud is low; self-host needs a 4 GB plus Linux host with ClickHouse, Kafka and Postgres, and PostHog states the open source deploy is for hobbyists without commercial support.
- **Game features:** Generic product analytics: funnels, retention, feature flags, experiments, session replay. No level or economy concepts.
- **WebGL:** Through its JavaScript library or HTTP capture API; no first party Unity SDK.
- **Pricing:** Cloud free for the first 1 million events a month.
- **Weaknesses:** Heavy to self-host, reported to need serious effort past a few hundred thousand events; game concepts must be modelled by hand.
- Sources: [Self-host disclaimer](https://posthog.com/docs/self-host/open-source/disclaimer), [Pricing](https://posthog.com/pricing), [README](https://github.com/posthog/posthog).

### 2.5 Umami

- **Open source / self-host:** MIT, self-host free with no event limits.
- **Setup effort:** Low on a Node and Postgres host.
- **Game features:** Web analytics with custom events through `umami.track()`. No sessions in the game sense, no levels.
- **WebGL:** Works in the browser page that hosts the build; nothing for native mobile.
- **Pricing:** Self-host free; cloud tiers vary by source.
- **Weaknesses:** Page view model; no mobile SDK; no per level or economy views.
- Sources: [Open source analytics by license](https://openpanel.dev/articles/open-source-web-analytics), [Plausible vs Umami 2026](https://use-apify.com/blog/plausible-vs-umami-2026).

### 2.6 Plausible

- **Open source / self-host:** AGPL Community Edition.
- **Setup effort:** Medium; Postgres plus ClickHouse.
- **Game features:** Goals as custom events with properties. Web only.
- **WebGL:** Browser page only.
- **Pricing:** Cloud from about 9 USD a month.
- **Weaknesses:** Web analytics product; no mobile SDK and no game model.
- Sources: [Plausible vs Matomo, Umami](https://www.databuddy.cc/blog/plausible-vs-matomo-vs-privacy-first-analytics-2026), [Open source analytics by license](https://openpanel.dev/articles/open-source-web-analytics).

### 2.7 Matomo

- **Open source / self-host:** GPL-3.0 On-Premise; some features are paid plugins.
- **Setup effort:** Medium; PHP and MySQL.
- **Game features:** Events with category, action, name, value. Heatmaps and A/B tests are paid plugins.
- **WebGL:** Browser page; mobile through the HTTP tracking API.
- **Pricing:** Self-host free; cloud and plugins paid.
- **Weaknesses:** Web oriented data model and interface; no game concepts.
- Sources: [Best Matomo alternatives](https://vemetric.com/blog/best-matomo-alternatives), [Open source analytics by license](https://openpanel.dev/articles/open-source-web-analytics).

### 2.8 Countly

- **Open source / self-host:** Countly Lite (formerly Community Edition), AGPL with added branding and commercial use conditions per third party summaries; Enterprise is proprietary.
- **Setup effort:** Medium to high; Node and MongoDB.
- **Game features:** Events, funnels and retention; user profiles and crash reports in Enterprise only per the Unity SDK feature list.
- **WebGL:** Has a Unity SDK and a web SDK.
- **Pricing:** Lite free; Enterprise quoted.
- **Weaknesses:** Licence conditions for commercial use need legal reading; heavy stack; game features generic.
- Sources: [Countly server](https://github.com/Countly/countly-server), [Licensing FAQ](https://support.countly.com/hc/en-us/articles/360037501312-Countly-Licensing-FAQ), [Countly alternative](https://openpanel.dev/compare/countly-alternative).

### 2.9 Aptabase

- **Open source / self-host:** Server AGPL-3.0, SDKs MIT, self-host supported.
- **Setup effort:** Low; Unity SDK by Git URL, a `SelfHostURL` field for self-hosted servers.
- **Game features:** Privacy first app analytics: events with properties, sessions, versions. No level, economy or ad revenue model.
- **WebGL:** The Unity SDK sends over HTTP; check per platform.
- **Pricing:** Cloud free to 20,000 events a month, paid from about 10 USD.
- **Weaknesses:** Small community; generic event charts; the closest technical match and the clearest proof that the licence split and Git URL install work.
- Sources: [Aptabase for Unity](https://aptabase.com/for-unity.md), [Unity SDK](https://github.com/aptabase/aptabase-unity), [Docs](https://aptabase.com/docs).

### 2.10 OpenPanel

- **Open source / self-host:** AGPL-3.0, Docker Compose self-host with no event cap.
- **Setup effort:** Low to medium.
- **Game features:** Mixpanel style events, funnels, retention. No game model.
- **WebGL:** JavaScript SDK in the page.
- **Pricing:** Cloud from 2.50 USD a month; free hosting for open source projects.
- **Weaknesses:** Product analytics, not game analytics.
- Sources: [Pricing](https://openpanel.dev/pricing), [Repository](https://github.com/Openpanel-dev/openpanel), [Self-hosted product analytics](https://openpanel.dev/articles/self-hosted-product-analytics).

### 2.11 Open source game specific analytics

- **Quest Data** describes itself as a game analytics platform for indie developers, targets Godot, and lists self-hosting as a future item. Source: [Quest Data docs](https://quest-data-docs.vercel.app/).
- No mature, self-hostable, open source analytics product with a per level model and a Unity SDK was found in a web search on 2026-11-18. The nearest technical match is Aptabase (2.9), which has no level model.

## 3. Comparison

| Product | Self-host | Level model | Economy and ads | Unity SDK | WebGL | Free limit |
|---|---|---|---|---|---|---|
| GameAnalytics | No | Yes, fixed three strings | Resource events, ad events | Yes | Yes | Core free |
| Unity Analytics | No | Funnels, custom events | Custom | Yes | Yes | 50k MAU |
| Firebase / GA4 | No | Recommended events, no level report | Yes, AdMob revenue | Yes | No | Free |
| PostHog | Heavy | No | No | No | JS | 1M events cloud |
| Umami | Yes, light | No | No | No | JS page | Unlimited self-host |
| Plausible | Yes, medium | No | No | No | JS page | Self-host |
| Matomo | Yes, medium | No | No | No | JS page | Self-host |
| Countly | Yes, heavy, licence conditions | Generic | Generic | Yes | Yes | Lite |
| Aptabase | Yes, light | No | No | Yes | Partial | 20k events cloud |
| OpenPanel | Yes, medium | No | No | No | JS page | Self-host |
| **idolytics** | **Yes, one click** | **Yes, first class** | **Yes, with revenue** | **Yes, Git URL** | **Yes** | **Self-host** |

## 4. The gap

1. The products that understand levels (GameAnalytics, Unity, Firebase) are hosted only and keep the data.
2. The products that self-host (Umami, Plausible, Matomo, OpenPanel, Aptabase, PostHog) model page views or generic events and have no level, attempt, booster, continue or ad revenue concept.
3. Firebase, the default for AdMob games, has no WebGL Unity build, so a game shipped to web portals loses analytics there.
4. Nothing combines an own-data collector with the Firebase data a mobile game already has (AdMob revenue, Crashlytics) in one per level view.

## 5. Unique selling proposition

**idolytics is per level game analytics you own: deploy it free on your own Cloudflare account in one click, drop a Unity package in by Git URL, and see where players clear, fail and quit each level, including WebGL, with Firebase and AdMob data joined in only if you want it.**

Supporting points:

- **Level first data model.** Attempt, duration, throws or moves, stars, score, result and quit reason are fields, not strings packed into a name.
- **Zero cost at indie scale.** The Cloudflare free plan carries 100,000 Worker requests and 100,000 D1 row writes a day ([Workers pricing](https://developers.cloudflare.com/workers/about/pricing), [D1 limits](https://developers.cloudflare.com/changelog/post/2026-09-01-d1-free-tier-limit-enforcement/)); with batching, the request limit stops mattering and D1 row writes bound ingest. Measured on idolytics 0.1.1, a stored event costs 2 row writes (the primary key table and one time index) plus 1 per batch for the daily cap counter, so the free plan holds about 45,000 events a day, which covers a game with a few thousand daily players. The paid Workers plan at 5 USD a month raises both limits.
- **Every platform Unity builds to, WebGL included.** The SDK talks plain HTTPS.
- **Firebase optional.** Tier 0 needs no Google account; Tier 1 and Tier 2 add BigQuery and Remote Config when a team already has them.
- **Engine neutral.** A documented JSON HTTP API serves Godot, web and custom engines.
- **Licence that protects the commons.** AGPL server, MIT SDK, so any game can ship the SDK and nobody can close the server.

## 6. Positioning

For indie and small studios making level based casual and puzzle games, idolytics is the self-hosted game analytics dashboard that answers "which level loses players and why" on the first day, unlike Firebase and GameAnalytics, which keep the data and need SQL or fixed hierarchies, and unlike Umami, Plausible or PostHog, which do not know what a level is.

## 7. Candidate names

1. **idolytics** (final name, chosen 2026-11-18). Trademark and domain search not yet done.
2. **LevelLens** and **PlayLedger** were the earlier working names.
