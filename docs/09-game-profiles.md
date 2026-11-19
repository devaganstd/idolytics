# 09. Game profiles: one analytics model for many genres

Status: draft for owner review, 2026-11-19. Target release: v0.3.0 (server and dashboard) with SDK 0.2.0. Builds on `03-event-schema` and `08-dashboard-v0.2`.

## 1. Why

The 0.1 and 0.2 model assumes a puzzle game. A player starts a numbered level, wins or fails it, and moves to the next one. The second studio game, Hex Battle Ground, does not fit:

| Assumption today | Hex Battle Ground |
|---|---|
| A play is a level with a number | A play is a 1v1 match against a bot; the content is a board, a mode and a difficulty |
| Progress is the next level | Progress is a trophy count that goes up and down, with arena tiers at 0, 300, 800 and 1500 |
| One value per property | A deck holds 8 cards |
| A few events per level | One match produces hundreds of in-match signals (tiles captured, cards deployed, merges) |

idolytics must not grow a custom system per game. Instead it gets one generic model (section 2) and a **game profile** per project (section 3), and the dashboard pages are built from the profile.

## 2. The generic model

The model has four concepts. Every genre maps onto them.

### 2.1 Play

A play is one bounded attempt: a level, a match, a run or a round.

| Event | Fields |
|---|---|
| `play_start` | `level` (the play key: a level id, a board or a stage), `attempt`, `props.kind` (`level`, `match`, `run`, `round`), `props.mode`, `props.difficulty`, `props.opponent` (`bot`, `human`, `none`) |
| `play_end` | the same keys, plus `props.result` (`win`, `loss`, `draw`, `quit`, `abandon`), `props.reason`, `duration_ms`, and `value` (the score) |

Rules:

- **Columns are reused.** The play key is stored in the existing `level` column, so the `events` table needs no change.
- **Results.** `win`, `loss` and `draw` come from the game. `quit` means the player left on purpose. `abandon` means the app closed during the play.
- **Abandon.** SDK 0.2.0 remembers an open play and sends `play_end` with `result: abandon` on the next launch. The server keeps inferring a quit after 30 minutes for older SDKs.
- **Summaries, not streams.** In-match detail goes into `play_end` props as counts, for example `cards_deployed`, `merges`, `owned_pct` and `towers_lost`. A profile should aim for 2 to 5 events per play. The free plan allows 100,000 row writes a day, and a raw event costs 2.

### 2.2 Progression track

A track is a number that measures how far a player has come.

| Event | Fields |
|---|---|
| `progress` | `props.track` (for example `trophies`, `arena`, `account_level`, `stage`), `value` (the new value), `props.delta` |

The dashboard shows how players are spread along each track, how many days it takes to reach a milestone (for example "arena 2 by day 3"), and where players stop advancing. A level funnel is a track whose milestones are the level keys in order.

### 2.3 Dimension

A dimension is a `props` key that the dashboard breaks results down by, for example `card`, `deck`, `board`, `difficulty`, `character` or `booster`.

- The profile declares which keys are dimensions. Only declared keys are rolled up, so costs stay predictable.
- **Multi-value dimensions.** A dimension marked `multi` holds up to 10 comma-separated values, for example `deck = "burst,canon,meteor"`. The rollup counts the play once for each value. This gives pick rate and win rate per card from a single `play_end`.
- Cardinality is capped at 200 values per dimension per project. Values beyond the cap are counted as `other`.

### 2.4 Flow step

A flow is an ordered funnel, such as onboarding, the tutorial or a shop flow.

| Event | Fields |
|---|---|
| `step` | `props.flow` (for example `ftue`, `tutorial1`, `shop`), `props.step` (an integer order), `props.step_id`, `duration_ms` (time in the step) |

The existing `tutorial_begin`, `tutorial_step`, `tutorial_complete` and `tutorial_skip` events count as flow `tutorial`.

## 3. Game profile

A game profile is a small JSON document stored per project and edited in Settings. It never changes what the server accepts; it only tells the rollups and the dashboard how to read the events.

```json
{
  "preset": "match_battle",
  "play_label": "Match",
  "play_kinds": ["match"],
  "tracks": [
    { "key": "trophies", "label": "Trophies", "milestones": [300, 800, 1500] },
    { "key": "arena", "label": "Arena", "milestones": [2, 3, 4] }
  ],
  "dimensions": [
    { "key": "board" },
    { "key": "difficulty" },
    { "key": "mode" },
    { "key": "deck", "multi": true, "label": "Card" },
    { "key": "trophies", "label": "Trophies at start", "bucket": 30 }
  ],
  "flows": ["tutorial1", "tutorial2"],
  "play_time_prop": "match_sec",
  "currencies": ["coins", "gems"],
  "moves_label": null
}
```

A dimension with `bucket` (v0.3.3) is a numeric band: the value is floor(x / bucket) * bucket shown as `0-49`, `50-99`, `-50--1` (a width that is not whole names the next band's start, such as `0-0.5`), read from `play_start` and from `play_end` only when the start does not send the key; a value that is not a number counts as `(none)`. The `match_battle` preset has `trophies` with bucket 30, so one normal win of +30 moves one band. The Content tab sorts bands by their start.

`play_time_prop` (v0.3.2, optional) names a numeric `play_end` props key with the in-game play time in seconds, without waiting screens such as a versus screen. The Plays page then shows its average, median and p90 as "In-game time". The `match_battle` preset sets it to `match_sec`; `""` unsets it.

### 3.1 Presets

A preset fills the profile with defaults. The developer edits from there.

| Preset | Example | Play | Tracks | Dimensions |
|---|---|---|---|---|
| `puzzle_levels` | Ninja Smash | `level`, ordered keys | `level` | `booster`, `difficulty` |
| `match_battle` | Hex Battle Ground | `match` | `trophies`, `arena` | `board`, `mode`, `difficulty`, `deck` (multi) |
| `run_roguelike` | runner, survivor | `run` | `best_score`, `account_level` | `character`, `biome` |
| `idle_tycoon` | idle, tycoon | `run` (one prestige cycle, from v0.3.1) | `stage`, `prestige_count`, `income_per_sec` (log10), `account_level` | `building`, `upgrade`, `boost`, `offer` |

### 3.2 Automatic detection

A project with no profile gets one. The cron looks at the event names of the last 7 days and picks a preset: `level_start` gives `puzzle_levels`, `play_start` with `kind: match` gives `match_battle`, and so on. The Settings page shows the guess as "Detected", and the developer can keep it or edit it. Dimensions are suggested from the most frequent props keys on play events.

## 4. Compatibility

Existing games need no change.

- **Old event names keep working forever.** The server treats `level_start` as `play_start` with `kind: level`, `level_complete` as `play_end` with `result: win`, `level_fail` as `result: loss`, and `level_quit` as `result: quit`. This mapping happens in the rollup, not in the raw rows, so data already stored is read the same way.
- **Old builds keep working.** The ingest API, the SDK 0.1 wire format and every write key stay valid. Ninja Smash on SDK 0.1.2 keeps its Levels page, its funnel and its inferred quits with no update.
- **Updating the SDK is the game's choice.** A UPM package pinned to a tag never updates on its own. That is deliberate, because an analytics change in a shipped build cannot be rolled back. SDK 0.2.0 is a drop-in update: `Track` is unchanged, and the new helpers are additions.
- **What an update would give Ninja Smash.** The abandon result when the app closes during a level, instead of a quit inferred after 30 minutes. Everything else is already available through the mapping.
- **Rollup migration.** `level_days` becomes `play_days`, with `kind`, `mode` and `difficulty` in the key. Existing rows are copied with `kind = level` and empty mode and difficulty, then the cron rebuilds the last 89 days from raw rows, as in 0.2.1.

## 5. Dashboard

The pages are generic and take their labels from the profile.

| Page | Content | Shown when |
|---|---|---|
| Plays (labelled Levels, Matches or Runs) | The 0.2.1 Levels table per play key, plus results by mode, difficulty and opponent; draws and abandons as columns | Play or level events exist |
| Progress | Players by track value, time to each milestone, and where players stop advancing | A track is declared and `progress` events exist |
| Content | One tab per dimension: plays, pick rate (share of plays using the value), win rate and average score, with version and date filters | A dimension is declared |
| Flows | A step funnel per flow, with time in step and drop off | `step` or `tutorial_*` events exist |

The 0.2 pages (Overview, Retention, Events, Economy and ads, Live, Device, Settings) are unchanged. All routes stay server rendered, and no game ships server code.

## 6. Data foundation

| Table | Key | Values |
|---|---|---|
| `play_days` (replaces `level_days`) | project, day, kind, play key, mode, difficulty, version, platform | the `level_days` values, plus draws and abandons |
| `dim_days` | project, day, dimension, value, kind, version, platform | completed plays (from v0.3.3), players, wins, losses, draws, score sum, duration and in-game time sums with histograms |
| `track_days` | project, day, track, bucket, version, platform | devices whose highest value that day falls in the bucket; buckets come from the milestones |
| `step_days` | project, day, flow, step, version, platform | devices that reached the step, duration sum and count |

Costs, measured the same way as in 0.2:

- **Writes.** About one row per dimension value per day, not per event. A multi-value deck adds at most one `dim_days` row per card per day, however many matches are played.
- **Reads.** Each new page reads only its rollup. The report must give `rows_read` per page on the smoke-test data and on data shaped like Hex Battle Ground (bots, 3 boards, 6 cards).

## 7. SDK 0.2.0

All new calls are additions. `Idolytics.Track` stays.

```csharp
Idolytics.PlayStart("hourglass", kind: "match", mode: "normal", difficulty: "easy",
    props: new() { ["opponent"] = "bot", ["deck"] = "burst,canon,meteor,pierce" });
Idolytics.PlayEnd(PlayResult.Win, score: 0.92, reason: "knockout",
    props: new() { ["cards_deployed"] = 14, ["merges"] = 3 });
Idolytics.Progress("trophies", 330, delta: 30);
Idolytics.Step("tutorial1", 3, "deploy_first_tower");
```

- One play can be open at a time. `PlayStart` closes an open play as `abandon` first.
- The open play is saved with the queue, so a play left open when the app closes is ended as `abandon` on the next launch, with its `duration_ms`.
- `attempt` is kept per play key on the device when the game does not pass one, as for levels today.
- WebGL rules are unchanged: `UnityWebRequest` only, no threads.

## 8. Example: Hex Battle Ground

This is an example of a profile, not code inside idolytics. The game writes its own adapter, as Ninja Smash did.

| Game moment | Event |
|---|---|
| `MatchRunner.MatchStarted` | `play_start` with `level` = board layout, `kind: match`, `mode` = `normal`, `tutorial1` or `tutorial2`, `difficulty` = bot difficulty, `opponent: bot`, `deck` = the 8 cards |
| `MatchSim` signal `Ended` | `play_end` with `result` from `MatchOutcome`, `reason` from `EndReason`, `value` = owned percent, and counts of deploys, merges, spells and towers lost |
| Trophy change after a match | `progress` with `track: trophies`, and `track: arena` when the arena changes |
| `FtueDirector.StepCompleted` | `step` with `flow` = the FTUE sequence, `step_id` and time in step |
| Chest opened, card upgraded | `item_acquired` and `upgrade_purchased` from `03-event-schema` |
| Rewarded ad | `ad_shown` and `ad_reward_granted` with `placement` |

The game gets retention from the SDK's own install id. That closes its current gap, which is that there is no install date and no player id.

## 9. Out of scope for v0.3

- Realtime PvP metrics: matchmaking wait, opponent rating, and fairness. They follow the game's multiplayer plan in v0.4.
- A funnel builder across arbitrary events. Flows cover declared steps only.
- A/B tests, segments and LTV, as in `08-dashboard-v0.2` section 6.

## 10. Phases

| Phase | Contents | Done when |
|---|---|---|
| A (v0.3.0) | Mapping of `level_*` to plays, `play_days`, `dim_days`, `track_days`, `step_days`, the profile with presets and automatic detection, and the Plays, Progress, Content and Flows pages | Ninja Smash shaped data shows the same numbers as in 0.2.1, and match shaped data on smoke-test matches a hand count |
| B (SDK 0.2.0) | `PlayStart`, `PlayEnd`, `Progress`, `Step`, abandon on next launch, and a match sample in `Samples~` | Batchmode tests pass in the host project, including a play left open across a restart |

Neither phase changes the HTTP API. Games on SDK 0.1.x need no update.
