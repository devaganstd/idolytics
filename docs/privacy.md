# Privacy (0.1)

Whoever deploys idolytics is the data controller for what their game sends. The idolytics project receives nothing: there is no telemetry to its authors.

## What is collected

| Data | Where it comes from | Stored |
|---|---|---|
| Install id | A random UUID the Unity SDK creates on first launch and keeps in `PlayerPrefs`. Reinstalling or clearing app data resets it. | Yes, as `device_id` |
| Session id | A random UUID per play session | Yes |
| Events | Names and properties the game sends, such as level, attempt, duration and booster | Yes |
| App version, platform, operating system version | The Unity SDK | Yes |
| Country | Two letter code from Cloudflare's request metadata | Yes |
| IP address | The network connection | **No.** Not read by idolytics code and not stored. Workers Logs are off in the shipped `wrangler.jsonc`; if you turn them on, Cloudflare keeps request logs under its own terms. |

The SDK does not read the advertising id, Android id, IDFA or IDFV, and does not ask for any permission. A `user_id` is stored only if the game sets one.

The server refuses events with properties named `email`, `name` or `phone`, and string values that look like an email address. The game must not send names, emails, free text typed by players, or device identifiers. The Ninja Smash adapter sends `name_set` without the name.

Data is sent over HTTPS when the endpoint is an `https://` URL, which is the case for every `workers.dev` and custom domain on Cloudflare.

## Retention and deletion

In 0.1, events are kept until you delete them. To delete one player's events, ask them for the install id (the game can show `Idolytics.InstallId` in a support screen) and run:

```bash
npx wrangler d1 execute idolytics --remote --command "DELETE FROM events WHERE device_id = '<install id>'"
```

An admin endpoint for deletion and export, and a retention setting, are planned for a later release.

## Google Play Data safety answers

For a game that uses idolytics as its only analytics, with no `user_id`:

| Question | Answer |
|---|---|
| Does your app collect or share any of the required user data types? | Yes |
| Is all of the user data collected by your app encrypted in transit? | Yes (with an `https://` endpoint) |
| Do you provide a way for users to request that their data is deleted? | Yes, if you offer the route above |
| **App activity: App interactions** | Collected, not shared. Purpose: Analytics. Processed ephemerally: No. Required. |
| **Device or other IDs** | Collected, not shared. Purpose: Analytics. Required. (The random install id counts as an identifier.) |
| **Location: Approximate location** | Collected, not shared. Purpose: Analytics. (The country code.) |

Data is not "shared" in the Play sense because it goes to a server you control, not to a third party. If your game also sends a `user_id` linked to an account, declare that under Personal info as well.

## Privacy policy paragraph

Adapt and add this to your game's privacy policy:

> We collect anonymous gameplay data to improve the game: which levels are started, won, lost or abandoned, how long they take, and which in-game items are used. The data is linked to a random identifier created on first launch, not to your name, email or advertising identifier, and includes the app version, the device's operating system and your country. It is sent over an encrypted connection to an analytics server that we operate ourselves, at [your endpoint domain], and is not sold or shared with third parties. Your IP address is not stored. To have your data deleted, contact us at [contact] with the player id shown in [where the game shows it].

## Children

Games directed at children must not set `user_id`, should keep the default data set above, and must follow the Google Play Families policy and COPPA where they apply. A consent switch in the SDK is planned for 0.2.
