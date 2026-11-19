# idolytics Unity SDK

Sends game events to your self-hosted idolytics server. Unity 2021.3 or newer, no dependencies, works on WebGL.

## Install

Package Manager > Add package from git URL:

```
https://github.com/devaganstd/idolytics.git?path=/sdk/unity
```

## Set up

1. Create > idolytics > Settings. Name it `IdolyticsSettings` and put it in a `Resources` folder.
2. Fill in `endpoint` (your server base URL, e.g. `https://idolytics.you.workers.dev`) and `writeKey` (`idl_w_...`).

The SDK starts itself after the first scene loads. To use another settings asset, call `Idolytics.Init(settings)`.

## Track

```csharp
using IdolyticsSdk;

Idolytics.Track("level_complete", new Dictionary<string, object>
{
    { "level", "12" }, { "attempt", 2 }, { "duration_ms", 41000L }, { "moves_left", 3 },
});
```

`level`, `attempt`, `duration_ms`, `value` and `currency` become event fields; other keys go to `props` (string, bool or number).
A `session_start` event is sent at launch and after 30 s in the background. Events are queued in `PlayerPrefs` (up to 1,000 events or about 256 KB; the oldest are dropped first) and sent in batches of up to 100 events and 60 KB. Prop strings longer than 100 characters are cut, and a negative `duration_ms` is left out.

The queue is saved at most every 2 s after `Track`, and when the app pauses or loses focus. On WebGL, closing the tab does not run `OnApplicationQuit`, so events tracked in the last 2 s before the tab closes can be lost.

The Ninja Smash sample (Package Manager > Samples) is a complete adapter from a game's own analytics interface.

## Plays, progress, steps and offline rewards (0.2.0, 0.2.1)

These helpers send the generic events every genre maps onto. `Track` is unchanged, so an existing integration keeps working.

```csharp
Idolytics.PlayStart("hourglass", kind: "match", mode: "normal", difficulty: "easy",
    props: new() { ["opponent"] = "bot", ["deck"] = "burst,canon,meteor,pierce" });
Idolytics.PlayEnd(PlayResult.Win, score: 0.92, reason: "knockout",
    props: new() { ["cards_deployed"] = 14, ["merges"] = 3 });
Idolytics.Progress("trophies", 330, delta: 30);
Idolytics.Step("tutorial1", 3, "deploy_first_tower", durationMs: 4200);
Idolytics.OfflineReward(durationMs: 7200000, value: 1.5e12, currency: "gold", multiplier: 2, via: "ad");
```

- `PlayStart(level, kind, mode, difficulty, props)` sends `play_start`. `level` is the play key (a level id, a board or a stage); `kind` is `level`, `match`, `run` or `round`. Without `props["attempt"]`, the attempt is counted per play key on the device.
- `PlayEnd(result, score, reason, props)` sends `play_end` with the play's start keys and props, `result` (`win`, `loss`, `draw`, `quit` or `abandon`), `reason`, `duration_ms` and `value` (the score). Put in-match detail in `props` as counts.
- One play is open at a time: `PlayStart` ends an open play as `abandon` first. `PlayEnd` with no open play logs a warning and sends nothing.
- A play still open when the app closes is ended as `abandon` on the next launch, with the duration up to the last save. While a play is open and `Idolytics.Init` has run, the SDK saves every 2 s, and also when the app pauses or loses focus. Its `ts` is that last save.
- `duration_ms` is scaled game time (`Time.time`): it stops while `Time.timeScale` is 0 and barely moves while the app is in the background.
- `Progress(track, value, delta)` sends `progress`, and `Step(flow, step, stepId, durationMs)` sends `step`.
- `OfflineReward(durationMs, value, currency, multiplier, via)` sends `offline_reward` (0.2.1). `via` is `free`, `ad` or `iap`.
- Idle games: a prestige cycle is a play of kind `run` that ends with `PlayResult.Prestige` (0.2.1), with the prestige currency gained as the score.
- `session_start` carries `since_last_ms` (0.2.1): the time since the previous session ended on this device, saved when the app pauses or quits. The first session has none.

The Match game sample (Package Manager > Samples) maps a 1v1 match game against a bot onto these calls.

## Developing the SDK

`sdk/unity-host/` is a minimal Unity 6000.3 project that references this package from disk (`file:../../unity`) and lists it in `testables`. Run the EditMode tests headless (Windows path shown; `-runTests` exits by itself, so do not add `-quit`):

```
"C:\Program Files\Unity\Hub\Editor\6000.3.22f1\Editor\Unity.exe" -batchmode -nographics -projectPath sdk/unity-host -runTests -testPlatform EditMode -testResults results.xml -logFile unity.log
```

Exit code 0 means all tests passed; failures are in `results.xml`. Check that the package builds for WebGL (needs the WebGL module):

```
"C:\Program Files\Unity\Hub\Editor\6000.3.22f1\Editor\Unity.exe" -batchmode -nographics -quit -projectPath sdk/unity-host -buildTarget WebGL -executeMethod HostBuild.WebGL -buildPath <out-dir> -logFile build.log
```

The host compiles copies of the samples (`Assets/NinjaSmashCheck/`, against stub Ninja Smash service types, and `Assets/MatchBattleCheck/`), because Unity never compiles `Samples~`. A host test fails when a copy differs from its sample, so copy the file again after editing a sample.
