# 08. Dashboard v0.2: filters, pages and rollups

Status: approved by the owner on 2026-11-18. Decisions: phases A, B and C in order as v0.2.0, v0.2.1 and v0.2.2; a per project reporting time zone (section 5.2); build without a mockup. Builds on `02-design` section 2.4 and the 0.2 row of `06-roadmap`.

## 1. What other game analytics dashboards show

Sources: GameAnalytics [metrics](https://docs.gameanalytics.com/events-metrics-and-filtering/metrics), [dashboards](https://docs.gameanalytics.com/products-and-features/analytics-iq/dashboards/overview) and [cohorts](https://docs.gameanalytics.com/products-and-features/analytics-iq/engagement-tools/cohorts/overview); Unity Analytics [dashboards](https://docs.unity.com/en-us/analytics/dashboards/dashboards), [Data Explorer](https://docs.unity.com/en-us/analytics/data-explorer/data-explorer-v2) and [audiences](https://docs.unity.com/en-us/analytics/audiences/standard-audiences); Firebase [dashboard](https://support.google.com/firebase/answer/6317517) and GA4 [cohort exploration](https://support.google.com/analytics/answer/9670133); PostHog [trends](https://posthog.com/docs/product-analytics/trends/overview).

Shared by GameAnalytics, Unity and Firebase (table stakes):

- **Activity:** DAU, MAU, new users, sessions, average session length, playtime per user, stickiness (DAU / MAU).
- **Retention:** classic DN retention (returned exactly N days after install), with D1, D7 and D30 shown everywhere and a cohort table by install day.
- **Monetization:** revenue over time, ARPDAU, ARPPU and conversion to payer.
- **Filters:** app version, platform and country.
- **Tools:** an events explorer.

Advanced or product specific:

- **GameAnalytics only:** progression and economy dashboards (sources and sinks).
- **Firebase/GA4 only:** rolling and cumulative retention.
- **Not in all three:** compare to the previous period, realtime, funnels, segments, LTV and hourly granularity.

Filters on any field are also common:

- **Any event property:** GameAnalytics Explore filters by custom dimensions and event fields. Filters of different types combine with AND, and several values of one filter combine with OR.
- **One player's history:** GA4 has a [User explorer](https://support.google.com/analytics/answer/9283607) that shows a single user's event timeline.
- **Cost:** GameAnalytics notes that unique type metrics often have filtering limitations, because arbitrary filters cannot use precomputed tables.

Every product precomputes its reports. Unity settles retention in a daily batch, GameAnalytics precomputes funnels, and GA4 reads aggregate tables and samples large explorations. idolytics must do the same, because every dashboard query is a paid D1 read.

## 2. Principles

1. **Genre neutral core, game modules on top.** The overview, retention and events pages work for any game. The levels, economy and ads modules appear only when the project has sent the matching standard events from `03-event-schema`. A runner, idle or match three game gets a useful dashboard with no configuration.
2. **One filter bar, every page.** Filters live in the URL query string, so a filtered view can be bookmarked and shared.
3. **Read rollups, not raw rows.** Only the live panel and the raw event tail touch the `events` table.
4. **Readable on a phone.** The layout is one column below 640 px, tables scroll sideways inside their card, and the filters collapse into one button.

## 3. Global filter bar

| Control | Values | Default |
|---|---|---|
| Date range | Today, 7, 14, 30, 90 days, custom from and to | 30 days |
| Compare | Off, previous period | Previous period on the KPI cards |
| App version | All, or one version, newest first | All |
| Platform | All, android, ios, webgl, editor | All |
| Country | All, or one country, top 20 by players | All |
| Players | All, new, returning | All |
| Time zone | Fixed UTC offsets, as in 0.1.3 | UTC |
| Device | One install id, typed or clicked from any table | None |
| Event | One or more event names | All |
| Level | One level key | All |
| Property | Any `props` key with a value, for example `booster = hammer` or `mode = hard`; up to three, combined with AND | None |

- **Per date.** A custom range with the same from and to date shows a single day. Clicking a day in any chart applies that day as the range.
- **Per device.** Clicking a device id anywhere opens the device page (section 4.7) and applies the device filter.
- **Rollup filters.** Date, version, platform, country, players and level are answered from rollups.
- **Raw filters.** Device, event and property filters need raw rows. While one of these is active, the page queries the `events` table, the range is capped at 30 days, and a banner says "Filtered on raw events". This keeps the free plan safe while allowing a filter on any field.

The selected version, platform and country also filter the retention cohorts. Following GameAnalytics, a cohort is filtered by the values a device had on its first day.

## 4. Pages

### 4.1 Overview

- **KPI cards**, each showing the change against the previous period:
  - average DAU
  - new users
  - sessions
  - average session length
  - playtime per user
  - D1 and D7 retention
  - stickiness
- **Daily players** as a stacked bar of new and returning devices, with a line for sessions.
- **Top events** by count.
- **Levels**: a short summary of the five levels with the highest quit rate, shown when the levels module is active.

### 4.2 Retention

- A cohort heatmap: install day rows, D0 to D30 columns, and the cell value is the percent of the cohort active that day.
- A summary row for D1, D3, D7, D14 and D30.
- Days that have not finished are marked incomplete, as GameAnalytics does.

### 4.3 Levels (module: `level_start`)

- **Sortable table**, one row per level:
  - starts and players
  - wins, fails and quits
  - win rate and first try win rate
  - attempts per win
  - average duration
  - average of `stars` and `moves_left` when the game sends them
- **Progression funnel**: players who reached each level, which shows where players stop.
- **Level detail page**:
  - the same numbers by day and by version
  - quit and fail reasons
  - boosters and continues used on that level

### 4.4 Economy and ads (module: `currency_*`, `booster_*`, `ad_*`, `iap_purchase`)

- **Currency**: earned and spent per currency by day, with the top sources and sinks.
- **Boosters**: use and offers by booster.
- **Ads**: shown by format per day, and revenue per day when `value` is sent.
- **Revenue metrics**: ARPDAU from the reported revenue.

### 4.5 Events

- Counts of any event name over time, with a breakdown by one property key, limited to the top 20 values.
- The raw tail of the last 100 events, filterable by name and by device id.

### 4.6 Live

- Devices active in the last 30 minutes.
- Events in the last 30 minutes.
- The newest events, read from raw rows with a time bound.

### 4.7 Device

- **Header:** first day, first version, platform, country and last day seen, from `devices` and `device_days`.
- **Days:** one row per day active, with sessions, playtime and highest level reached.
- **Timeline:** every event of the device in the selected range, newest first, with all props.
- **Purpose:** a support and debugging view, for example "why did this player quit at level 12". It also serves the deletion and export requests in `02-design` section 5.

### 4.8 Settings

- Projects.
- The reporting time zone of each project (see section 5.2).
- The daily ingest cap and today's usage against it.
- A D1 usage estimate.

## 5. Data foundation

### 5.1 Rollups

A Cron Trigger runs every 15 minutes. It reads only the raw rows received since the last run, tracked by a per-project watermark on `received_at`, and upserts these tables.

| Table | Key | Values | Powers |
|---|---|---|---|
| `devices` | project, device | first day, first version, platform, country | new users, cohorts |
| `device_days` | project, day, device | version, platform, country, sessions, playtime ms, events | DAU, MAU, sessions, playtime, retention, stickiness, filters |
| `level_days` | project, day, level, version, platform | starts, players, wins, fails, quits, first try wins, duration sum and count, stars sum, moves sum | levels page, funnel, level detail |
| `event_days` | project, day, name, version, platform | count, devices, value sum | top events, economy, ads, events page |

Rules:

- **Writes.** About one row per active device per day, plus one row per level, event name, version and platform per day. That is far below the per-event cost of raw ingest.
- **Reads.** The dashboard reads at most a few thousand rollup rows per page, compared with today's full scans of 30 days of raw events.
- **Quits.** A late quit, which only becomes a quit after 30 minutes without a result, is folded in when it ages out.
- **Retention of raw rows.** Raw events older than 90 days are deleted by the same cron. Rollups are kept forever.

### 5.2 Time zone and rollups

A daily rollup is cut at midnight of one time zone. Rolling up by hour would cost about 24 times more rows. So each project gets one **reporting time zone**, which is used by the rollups and by the dashboard.

The 0.1.3 time zone selector becomes this project setting. A change applies to new rollups at once, and the cron rebuilds the last 90 days from the raw rows.

## 6. Out of scope for v0.2

- Segments and audiences.
- A funnel builder.
- LTV.
- Rolling and cumulative retention.
- Hourly charts beyond the live panel.
- A/B tests.
- Exports.
- Multi-user accounts.
- Firebase data, which is Tier 1.

## 7. Phases

| Phase | Contents | Done when |
|---|---|---|
| A | Rollup tables, cron, watermark, raw retention, filter bar, Overview with compare, Retention | The numbers match a hand count on seeded data, and a dashboard load reads no raw rows |
| B | Levels page upgrade, progression funnel, level detail, Events page, raw filters (device, event, property), Device page | Ninja Smash smoke data shows correct win, quit and first try rates |
| C | Economy and ads module, Live, Settings with usage meter | Modules hide when their events are absent |

Each phase is one release: v0.2.0, v0.2.1 and v0.2.2. None changes the SDK or the HTTP API, so games need no update.
