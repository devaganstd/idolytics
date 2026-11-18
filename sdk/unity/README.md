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

## Developing the SDK

`sdk/unity-host/` is a minimal Unity 6000.3 project that references this package from disk (`file:../../unity`) and lists it in `testables`. Run the EditMode tests headless (Windows path shown; `-runTests` exits by itself, so do not add `-quit`):

```
"C:\Program Files\Unity\Hub\Editor\6000.3.22f1\Editor\Unity.exe" -batchmode -nographics -projectPath sdk/unity-host -runTests -testPlatform EditMode -testResults results.xml -logFile unity.log
```

Exit code 0 means all tests passed; failures are in `results.xml`. Check that the package builds for WebGL (needs the WebGL module):

```
"C:\Program Files\Unity\Hub\Editor\6000.3.22f1\Editor\Unity.exe" -batchmode -nographics -quit -projectPath sdk/unity-host -buildTarget WebGL -executeMethod HostBuild.WebGL -buildPath <out-dir> -logFile build.log
```

The host compiles a copy of `Samples~/NinjaSmash` in `Assets/NinjaSmashCheck/` against stub Ninja Smash service types, because Unity never compiles `Samples~`. A host test fails when the copy differs from the sample, so copy the file again after editing the sample.
