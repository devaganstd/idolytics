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

## Standard events used by the 0.1 dashboard

### Session

| Event | Fields | Notes |
|---|---|---|
| `session_start` | | Sent by the Unity SDK at launch and after 30 seconds in the background. |

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
- **Quits** are inferred. For each device, level and attempt, every `level_start` not closed by a `level_complete`, `level_fail` or `level_quit` counts as a quit once the last start reached the server 30 minutes ago. Sessions are ignored, so a level resumed after a restart and then finished is not a quit. `level_quit` events the game sends are added. A game that never sends `level_quit` still gets a quit count.

### Boosters

| Event | Fields |
|---|---|
| `booster_used` | `level`, `attempt`, `props.booster`, `props.source` (`stock`, `trial`, `gift`) |

The dashboard also counts the Ninja Smash events `booster_bought` and `try_taken` as booster use, grouped by `props.booster`.

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
