# 03. Event schema

Schema version 1. Puzzle and casual level games first; other genres extend it through custom events and the `props` object. GA4 names are from the [recommended events reference](https://support.google.com/analytics/answer/9267735) and the [automatically collected events](https://support.google.com/analytics/answer/9234069) list.

## 1. Envelope

Every request is a batch:

```json
{
  "schema": 1,
  "sdk": "unity/0.1.0",
  "device_id": "5f0c...",
  "app_version": "1.4.0",
  "build": "37",
  "platform": "android",
  "os": "Android 14",
  "locale": "id-ID",
  "events": [ { ... }, { ... } ]
}
```

Every event:

| Field | Type | Required | Notes |
|---|---|---|---|
| `event_id` | UUID string | yes | Deduplication key |
| `name` | string | yes | Standard name or custom name (section 13) |
| `ts` | integer, ms since epoch | yes | Device clock |
| `session_id` | UUID string | yes | Set by `session_start` |
| `user_id` | string | no | Game account id, never personal data |
| `level` | string | per event | Stable level key, e.g. `"12"` or `"w2_l12"` |
| `attempt` | integer | per event | 1 for the first try at a level by this device |
| `duration_ms` | integer | per event | Measured on the device, non-negative |
| `value` | number | per event | Amount of currency, score or revenue |
| `currency` | string | per event | ISO 4217 for money, a game key for virtual currency |
| `props` | object | no | Up to 25 keys of string, number or boolean |

Fields that are not columns in the event table are kept in `props` by the server.

## 2. Session and lifecycle

| Event | Fields | GA4 equivalent | Notes |
|---|---|---|---|
| `first_open` | | `first_open` (automatic) | Sent once per `device_id` |
| `session_start` | `props.rc` (map of active remote config values), `props.install_source` | `session_start` (automatic) | A new session after 30 s in background, configurable |
| `session_end` | `duration_ms` (foreground time) | none | Sent on pause or next launch if the app was killed |
| `app_update` | `props.from_version` | `app_update` (automatic) | |
| `screen_view` | `props.screen` | `screen_view` | Menu, shop, settings; levels use level events |

## 3. Levels

| Event | Fields | GA4 equivalent |
|---|---|---|
| `level_start` | `level`, `attempt`, `props.mode`, `props.difficulty`, `props.boosters_owned` | `level_start` (`level_name`) |
| `level_complete` | `level`, `attempt`, `duration_ms`, `value` (score), `props.stars`, `props.moves`, `props.moves_left`, `props.destroyed_pct` | `level_end` (`level_name`, `success: true`); `post_score` for the score |
| `level_fail` | `level`, `attempt`, `duration_ms`, `props.reason` (`out_of_moves`, `timeout`, `fell`), `props.moves`, `props.targets_left` | `level_end` (`success: false`) |
| `level_quit` | `level`, `attempt`, `duration_ms`, `props.via` (`menu`, `restart`, `app_closed`) | `level_end` (`success: false`) with a custom `result` parameter |

Rules:

- `moves` is the genre neutral name for the player's spend unit: throws, shots, swaps, taps. The game names it once in project settings so the dashboard can label it.
- Every `level_start` is closed by exactly one of complete, fail or quit. The SDK closes an open level as `level_quit` with `via: app_closed` on the next launch.
- `attempt` counts starts of that level on that device, including restarts. The SDK keeps the counter if the game does not pass one.
- `duration_ms` excludes time paused and time in the background.

## 4. Continue and revive

| Event | Fields | GA4 equivalent |
|---|---|---|
| `continue_offered` | `level`, `attempt`, `props.options` (`ad`, `coins`) | none |
| `continue_used` | `level`, `attempt`, `props.method` (`ad`, `coins`, `item`), `value` (cost), `currency`, `props.granted` (e.g. 5 moves) | `spend_virtual_currency` when paid in currency |
| `continue_declined` | `level`, `attempt` | none |

## 5. Boosters and power ups

| Event | Fields | GA4 equivalent |
|---|---|---|
| `booster_used` | `level`, `attempt`, `props.booster`, `props.source` (`stock`, `trial`, `gift`) | none |
| `booster_offer_shown` | `level`, `props.booster`, `props.kind` (`trial`, `shop`) | none |
| `booster_offer_taken` | `level`, `props.booster`, `props.kind` | none |

## 6. Items, upgrades and unlocks

| Event | Fields | GA4 equivalent |
|---|---|---|
| `item_acquired` | `props.item`, `props.item_type` (`booster`, `skin`, `upgrade`), `props.quantity`, `props.source` (`shop`, `reward`, `gift`, `iap`) | `earn_virtual_currency` is not a fit; use `select_item` for shop picks |
| `item_unlocked` | `props.item`, `level` (where it unlocked) | `unlock_achievement` (`achievement_id`) |
| `upgrade_purchased` | `props.item`, `props.tier`, `value`, `currency` | `spend_virtual_currency` (`item_name`) |

## 7. Currency

| Event | Fields | GA4 equivalent |
|---|---|---|
| `currency_earn` | `value`, `currency`, `props.source` (`level_reward`, `ad_reward`, `daily`, `iap`), `level` | `earn_virtual_currency` (`virtual_currency_name`, `value`) |
| `currency_spend` | `value`, `currency`, `props.sink` (`booster`, `continue`, `skin`), `props.item`, `level` | `spend_virtual_currency` (`virtual_currency_name`, `value`, `item_name`) |

Send one `currency_earn` per reward moment, not one per coin. Balance is optional in `props.balance` and lets the dashboard draw a balance distribution.

## 8. Ads

| Event | Fields | GA4 equivalent |
|---|---|---|
| `ad_requested` | `props.format` (`rewarded`, `interstitial`, `banner`), `props.placement` | none |
| `ad_shown` | `props.format`, `props.placement`, `level` | none |
| `ad_impression` | `props.format`, `props.placement`, `props.network`, `props.ad_unit`, `value` (revenue), `currency`, `props.precision` | `ad_impression` (`ad_platform`, `ad_source`, `ad_format`, `ad_unit_name`, `value`, `currency`) |
| `ad_reward_granted` | `props.placement`, `props.reward` | none |
| `ad_failed` | `props.format`, `props.placement`, `props.error` | none |

Revenue comes from the mediation SDK paid event (AdMob `OnAdPaid`, which reports micros; the SDK divides by 1,000,000). Tier 1 replaces it with the BigQuery figure for reporting when both exist; Tier 0 shows the device reported figure, labelled as an estimate.

## 9. In-app purchases

| Event | Fields | GA4 equivalent |
|---|---|---|
| `iap_started` | `props.product_id`, `props.placement` | `begin_checkout` |
| `iap_completed` | `props.product_id`, `value`, `currency`, `props.transaction_id`, `props.store` | `purchase` (`transaction_id`, `value`, `currency`, `items`) |
| `iap_failed` | `props.product_id`, `props.reason` (`cancelled`, `error`) | none |

The server does not validate receipts. Revenue shown is device reported.

## 10. Tutorial and onboarding funnel

| Event | Fields | GA4 equivalent |
|---|---|---|
| `tutorial_begin` | `props.tutorial` | `tutorial_begin` |
| `tutorial_step` | `props.tutorial`, `props.step` (integer), `props.step_name` | none |
| `tutorial_complete` | `props.tutorial`, `duration_ms` | `tutorial_complete` |
| `tutorial_skip` | `props.tutorial`, `props.step` | none |

The Funnel page also builds the first time user experience funnel from `first_open`, `tutorial_*` and the first N `level_complete` events without extra instrumentation.

## 11. Rating prompt

| Event | Fields | GA4 equivalent |
|---|---|---|
| `rating_prompt_shown` | `level`, `props.trigger` | none |
| `rating_prompt_result` | `props.result` (`rate`, `later`, `never`, `dismissed`) | none |

Store review APIs do not report whether a review was written; `rate` means the system dialog was requested.

## 12. Errors and unlocks of the app itself

| Event | Fields | GA4 equivalent |
|---|---|---|
| `error` | `props.code`, `props.context` | none; crashes come from Crashlytics in Tier 1 |
| `feature_unlocked` | `props.feature`, `level` | `unlock_achievement` |

## 13. Custom events

- **Name:** `^[a-z][a-z0-9_]{0,39}$`, snake case, verb last where natural (`chest_opened`). Names starting with `idl_` are reserved. Standard names cannot be redefined.
- **Properties:** at most 25 per event, keys in the same pattern, string values at most 100 characters, numbers finite, booleans allowed, no nested objects or arrays.
- **Limits per project:** 200 distinct custom event names and 500 distinct property keys by default. Past the limit, events are counted under `idl_dropped` with the original name in a sample table so the developer can see what overflowed.
- **No personal data:** keys such as `email`, `name`, `phone` and values that look like an email are rejected.
- **Level linking:** a custom event that carries `level` appears on that level's detail page automatically.
- **Declaring:** optional. A project may declare a custom event in settings with a label, a unit and which property to sum, so the dashboard charts it with a proper axis. Undeclared events still arrive and show in the Events explorer.

## 14. Extending to other genres

- **Runner or arcade:** `level` becomes the run or stage key; `value` the distance or score; `props.reason` on `level_fail` names the obstacle.
- **RPG or idle:** `level_up` (custom, maps to GA4 `level_up`) with `props.character`; `item_acquired` and `upgrade_purchased` carry the progression.
- **Match three or merge:** `moves` and `moves_left` carry over unchanged.

## 15. Ninja Smash mapping (first adopter)

| Current `IAnalyticsService` call | idolytics event |
|---|---|
| `level_start` | `level_start` |
| `level_win` | `level_complete` with `props.moves` = throws used, `props.moves_left` |
| `level_lose` | `level_fail` with `props.reason: out_of_moves`, `props.targets_left` |
| `continue_watched` | `continue_used` with `props.method: ad` |
| `booster_bought` | `currency_spend` with `props.sink: booster` and `item_acquired` |
| `try_offer_shown`, `try_taken` | `booster_offer_shown`, `booster_offer_taken` with `props.kind: trial` |
| `interstitial_shown` | `ad_shown` with `props.format: interstitial` |
| `review_card_shown`, `review_rate`, `review_later` | `rating_prompt_shown`, `rating_prompt_result` |
| `unlock_shown` | `item_unlocked` or `feature_unlocked` |
| `home_unlocked`, `hard_card_shown`, `name_set`, `save_corrupt` | custom events with the same names |

New events Ninja Smash would add: `level_quit`, `booster_used`, `currency_earn`, `ad_impression` with revenue, `session_start` with remote config values.
