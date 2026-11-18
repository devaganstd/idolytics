# idolytics Unity SDK

Sends game events to your self-hosted idolytics server. Unity 2021.3 or newer, no dependencies, works on WebGL.

## Install

Package Manager > Add package from git URL:

```
https://github.com/<org>/idolytics.git?path=/sdk/unity
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
A `session_start` event is sent at launch and after 30 s in the background. Events are queued in `PlayerPrefs` (up to 1,000) and sent in batches.

The Ninja Smash sample (Package Manager > Samples) is a complete adapter from a game's own analytics interface.
