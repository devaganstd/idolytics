# Changelog

## 0.2.1

- Added `Idolytics.OfflineReward` for offline earnings: `duration_ms`, `value`, `currency`, `props.multiplier` and `props.via`.
- `session_start` now carries `props.since_last_ms`, the time since the previous session on this device ended (on pause, quit or session end). The first session has none, and a device clock that moved back gives none.
- Added `PlayResult.Prestige` (result `prestige`) for idle games: a prestige cycle is a play of kind `run`.

## 0.2.0

- Added `Idolytics.PlayStart` and `Idolytics.PlayEnd` for levels, matches, runs and rounds, with `PlayResult`. One play is open at a time; `PlayStart` ends an open play as `abandon`.
- A play left open when the app closes is sent as `abandon` on the next launch, with its duration so far.
- `attempt` is counted per play key on the device when the game does not pass one.
- Added `Idolytics.Progress` for progression tracks and `Idolytics.Step` for flow steps.
- Added the Match game sample, a generic adapter for a 1v1 match game against a bot.
- `Track` and the 0.1 wire format are unchanged.

## 0.1.2

- AutoInit no longer warns when there is no `Resources/IdolyticsSettings` asset.
- Ninja Smash sample: `duration_ms` uses scaled game time.
- The sample script ships with a fixed GUID.

## 0.1.1

- Batches are capped at 100 events and 60 KB, with retry in halves on 400 and 413, and backoff on other failures.
- The queue is saved at most every 2 s after `Track` and is capped at about 256 KB.
- Negative `duration_ms` is left out and prop strings are cut to 100 characters.

## 0.1.0

- First release: `Idolytics.Track`, a persisted event queue and a batched sender that runs on WebGL.
