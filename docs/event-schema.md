# Event schema (0.1)

What a game sends to `POST /v1/events`, and what the server accepts. The full design, including events planned for later releases, is in [03-event-schema.md](03-event-schema.md).

## Request

```
POST /v1/events
Authorization: Bearer idl_w_...
Content-Type: application/json
```

```json
{
  "schema": 1,
  "sdk": "unity/0.1.0",
  "device_id": "5f0c8d2e-0d4b-4bd1-9a7e-2f1d6c3b9a10",
  "app_version": "1.4.0",
  "platform": "android",
  "os": "Android 14",
  "events": [
    {
      "event_id": "0b6f2a4e-3c1d-4f8a-9e2b-7d5c1a0f6e33",
      "name": "level_complete",
      "ts": 1795000000000,
      "session_id": "a1c2e3f4-5b6d-4e7f-8a9b-0c1d2e3f4a5b",
      "level": "12",
      "attempt": 2,
      "duration_ms": 41000,
      "props": { "moves_left": 3, "stars": 2 }
    }
  ]
}
```

| Batch field | Rule |
|---|---|
| `device_id` | Required. The random install id, at most 64 characters. |
| `app_version`, `platform`, `os` | Optional strings, at most 64 characters. |
| `events` | Required array, at most 100 events. |

The whole body is at most 64 KB. Gzip is not accepted in 0.1.

## Event fields

| Field | Type | Required | Rule |
|---|---|---|---|
| `event_id` | string | yes | Unique per event, at most 64 characters. A UUID v4 is expected. A retried event with the same id is stored once. |
| `name` | string | yes | `^[a-z][a-z0-9_]{0,39}$`. Names starting with `idl_` are reserved. |
| `ts` | integer | yes | Milliseconds since 1970 on the device clock. A value more than 30 days in the past or 1 day in the future is replaced with the time the server received the event. |
| `session_id` | string | yes | At most 64 characters. |
| `user_id` | string | no | The game's own account id. Never personal data. |
| `level` | string or integer | no | Stable level key, at most 40 characters. Stored as a string. |
| `attempt` | integer | no | Starts of this level by this device, counting from 1. A negative or non-integer value is stored as empty; the event is kept. |
| `duration_ms` | integer | no | Measured on the device. A negative or non-integer value is stored as empty; the event is kept. |
| `value` | number | no | Score, amount or revenue. Finite. |
| `currency` | string | no | ISO 4217 for money, a game key for virtual currency. At most 16 characters. |
| `props` | object | no | At most 25 keys. Keys follow the name rule. Values are strings of at most 100 characters, finite numbers or booleans. No nested objects or arrays. |

Unknown top level fields are ignored.

### Rejected events

An event that breaks a rule is rejected on its own; the rest of the batch is stored. The response counts both:

```json
{ "accepted": 99, "rejected": 1 }
```

A whole batch is refused with `401` for a missing or unknown write key, `413` over 64 KB, `400` for invalid JSON, a missing `device_id` or a bad `events` array, and `429` with `Retry-After` once the project has reached its daily event cap.

### Daily event cap

Each project accepts up to 20,000 events per UTC day by default, set with the `DAILY_EVENT_CAP` variable. It protects the D1 free plan from a leaked write key or a bug that floods events. The cap is checked before each batch, so batches arriving at the same moment can pass it by one batch each. A replayed batch counts again. The free plan's D1 write budget is per account, not per project. The Unity SDK keeps refused events and retries with backoff. `Retry-After` gives the seconds until the next UTC midnight.

### Personal data is refused

Props named `email`, `name` or `phone`, and string values that look like an email address, reject the event. Never send names, emails, free text typed by the player, or device identifiers.

## Standard events used by the dashboard

### Session

| Event | Fields | Notes |
|---|---|---|
| `session_start` | `props.since_last_ms` (SDK 0.2.1) | Sent by the Unity SDK at launch and after 30 seconds in the background. `since_last_ms` is the time since the previous session ended on this device; the first session has none. The Overview buckets it: under 1 h, 1 to 4 h, 4 to 12 h, 12 to 24 h, over 24 h. |

Daily players count distinct `device_id`; sessions count distinct `session_id`.

### Levels

| Event | Fields | GA4 equivalent |
|---|---|---|
| `level_start` | `level`, `attempt`, optional `props.mode`, `props.difficulty` | `level_start` |
| `level_complete` | `level`, `attempt`, `duration_ms`, optional `value` (score), `props.stars`, `props.moves`, `props.moves_left` | `level_end` with `success: true` |
| `level_fail` | `level`, `attempt`, `duration_ms`, optional `props.reason` (`out_of_moves`, `timeout`, `fell`), `props.moves`, `props.targets_left` | `level_end` with `success: false` |
| `level_quit` | `level`, `attempt`, `duration_ms`, optional `props.via` (`menu`, `restart`, `app_closed`) | `level_end` with `success: false` |

`moves` is the genre neutral name for the player's spend unit: throws, shots, swaps or taps.

How the dashboard reads them:

- **Win rate** is wins / (wins + losses).
- **Attempts per win** is starts / wins.
- **Quits** are inferred. For each device, level and attempt, a `level_start` not closed by a `level_complete`, `level_fail` or `level_quit` counts as a quit once it reached the server 30 minutes ago, on the day of the start. Sessions are ignored, so a level resumed after a restart and finished within two days takes the quit back. `level_quit` events the game sends are added. A game that never sends `level_quit` still gets a quit count.

### Boosters

| Event | Fields |
|---|---|
| `booster_used` | `level`, `attempt`, `props.booster`, `props.source` (`stock`, `trial`, `gift`) |

The Economy page also counts `booster_bought` and the Ninja Smash event `try_taken` as booster use, and `booster_offered` and the Ninja Smash event `try_offer_shown` as offers, grouped by `props.booster`.

### Economy and ads

| Event | Fields |
|---|---|
| `currency_earned` | `currency`, `value` (the amount), `props.source` |
| `currency_spent` | `currency`, `value` (the amount), `props.sink` |
| `booster_offered` | `props.booster` |
| `ad_shown` | `props.format` (`interstitial`, `rewarded`, `banner`), `value` (revenue, if known), `currency` (of the revenue) |
| `iap_purchase` | `props.product`, `value` (the price), `currency` |

Ninja Smash's `interstitial_shown` and `continue_watched` count as `ad_shown` with the format `interstitial` and `rewarded`. Revenue and ARPDAU show only for events that send `value` with a `currency`. Each of these events is rolled up into one row per day, name, currency, detail, version and platform, so keep sources, sinks, boosters and products to a short fixed list.

## Plays, progress and steps (SDK 0.2.0)

A play is one level, match, run or round. `level_*` events are read as plays of kind `level`, so games on SDK 0.1 keep working.

| Event | Fields |
|---|---|
| `play_start` | `level` (the play key: a level, a board or a stage), `attempt`, `props.kind` (`level`, `match`, `run`, `round`), `props.mode`, `props.difficulty`, `props.opponent` |
| `play_end` | the same keys, plus `props.result` (`win`, `loss`, `draw`, `quit`, `abandon`, `prestige`), `props.reason`, `duration_ms`, `value` (the score, or the prestige currency gained) |
| `progress` | `props.track` (such as `trophies`), `value` (the new value), `props.delta` |
| `step` | `props.flow`, `props.step` (an integer from 0), `props.step_id`, `duration_ms` |

The game profile declares which props keys are dimensions; a dimension marked `multi`, such as a deck, holds up to 10 comma-separated values, and each counts the play once. Each dimension keeps at most 200 values; later ones count as `other`. Tracks are counted by their milestones only; a track with `"scale": "log10"` defaults to the milestones 1e3, 1e6, 1e9 and on. `tutorial_begin`, `tutorial_step` (`props.step`) and `tutorial_complete` are the flow `tutorial`, and `tutorial_skip` (`props.step`) a skip at that step. A play event without `level` counts under the play key `(none)`.

### Idle games (v0.3.1)

A run is one prestige cycle: `play_start` with `props.kind` `run`, then `play_end` with `props.result` `prestige`, `value` the prestige currency gained and `duration_ms` the time to prestige. A prestige counts as a completed run, not a win.

| Event | Fields |
|---|---|
| `offline_reward` | `duration_ms` (time offline), `value`, `currency`, `props.multiplier` (1, 2, 3), `props.via` (`free`, `ad`, `iap`) |

The Economy page shows the average time offline, the share taken with an ad, and the offline share of currency earned. Keep the event budget small: send `progress` on milestones, at session start and at prestige, never on every value change; summarize upgrade purchases per session in `session_end` props, such as `upgrades_bought`; aim for fewer than 15 events per session.

## Custom events

Any name that follows the name rule is accepted and shows in the latest events list. Use snake case with the verb last, such as `chest_opened`. Put `level` on an event that happens inside a level so it can be linked to that level later.

```csharp
Idolytics.Track("hint_used", new Dictionary<string, object> { { "level", "12" }, { "hint", "show_target" } });
```

## Mapping an existing game: Ninja Smash

The Ninja Smash adapter (`sdk/unity/Samples~/NinjaSmash`) maps the game's calls like this:

| Game call | Sent as |
|---|---|
| `level_start` (`level`, `attempt`) | `level_start`; the adapter remembers the attempt and start time per level |
| `level_win` (`level`, `throws_left`) | `level_complete` with `attempt`, `duration_ms`, `props.moves_left` |
| `level_lose` (`level`, `pieces_left`) | `level_fail` with `attempt`, `duration_ms`, `props.targets_left`, `props.reason: out_of_moves` |
| `name_set` | `name_set` with no properties, so the name is never sent |
| every other call | the same name and parameters |
