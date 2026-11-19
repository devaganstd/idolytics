using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text;
using UnityEngine;

namespace IdolyticsSdk
{
    /// <summary>How a play ended. Sent as props.result in lower case.</summary>
    public enum PlayResult { Win, Loss, Draw, Quit, Abandon }

    // Plays, progression tracks and flow steps (docs/09-game-profiles.md, sections 2 and 7).
    public static partial class Idolytics
    {
        const string PlayKey = "idolytics.play";
        const string AttemptKey = "idolytics.attempt.";
        static readonly CultureInfo Inv = CultureInfo.InvariantCulture;

        /// <summary>The play clock: scaled game time, so time at Time.timeScale 0 is not counted. Tests replace it.</summary>
        internal static Func<float> Clock = () => Time.time;

        class OpenPlay
        {
            public string SessionId;
            public Dictionary<string, object> Props; // level, attempt, kind, mode, difficulty and the game's props
            public float Start;
        }

        static OpenPlay openPlay;

        /// <summary>True while a play is open; the sender then saves every 2 s so an abandon keeps its duration.</summary>
        internal static bool PlayOpen => openPlay != null;

        /// <summary>
        /// Starts a play (a level, match, run or round) and sends play_start. <paramref name="level"/> is the
        /// play key. Without props["attempt"] the attempt is counted per play key on this device.
        /// An open play is first ended as abandon.
        /// </summary>
        public static void PlayStart(string level, string kind = "level", string mode = null, string difficulty = null,
            Dictionary<string, object> props = null)
        {
            if (string.IsNullOrEmpty(level))
            {
                Debug.LogWarning("[idolytics] PlayStart called with an empty play key.");
                return;
            }
            if (openPlay != null) PlayEnd(PlayResult.Abandon);

            var p = props != null ? new Dictionary<string, object>(props) : new Dictionary<string, object>();
            p["kind"] = kind;
            if (mode != null) p["mode"] = mode;
            if (difficulty != null) p["difficulty"] = difficulty;
            int attempt = p.TryGetValue("attempt", out object a) && int.TryParse(Convert.ToString(a, Inv), NumberStyles.Integer, Inv, out int n)
                ? n
                : PlayerPrefs.GetInt(AttemptKey + level) + 1;
            PlayerPrefs.SetInt(AttemptKey + level, attempt);
            p["level"] = level;
            p["attempt"] = attempt;

            if (SessionId == null) StartSession();
            openPlay = new OpenPlay { SessionId = SessionId, Props = p, Start = Clock() };
            Enqueue("play_start", p);
            Save(); // the saved play and the queue change together, so a kill cannot split them
        }

        /// <summary>
        /// Ends the open play and sends play_end with the play_start keys, props.result, props.reason,
        /// duration_ms (scaled game time) and value (the score).
        /// </summary>
        public static void PlayEnd(PlayResult result, double? score = null, string reason = null, Dictionary<string, object> props = null)
        {
            if (openPlay == null)
            {
                Debug.LogWarning("[idolytics] PlayEnd called with no open play.");
                return;
            }
            var p = EndProps(openPlay.Props, result, ElapsedMs(openPlay));
            if (props != null) foreach (var kv in props) p[kv.Key] = kv.Value;
            if (reason != null) p["reason"] = reason;
            if (score.HasValue) p["value"] = score.Value;
            // The start session, as the abandon on next launch uses, even if a new session began mid-play.
            string session = openPlay.SessionId;
            openPlay = null;
            Queue.Enqueue(EventBuilder.Build("play_end", p, session, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), Guid.NewGuid().ToString()));
            Save();
        }

        /// <summary>Sends progress: the new <paramref name="value"/> of a progression track, such as trophies.</summary>
        public static void Progress(string track, double value, double? delta = null) =>
            Track("progress", new Dictionary<string, object> { ["track"] = track, ["value"] = value, ["delta"] = delta });

        /// <summary>Sends step: step number <paramref name="step"/> of a flow, such as the tutorial.</summary>
        public static void Step(string flow, int step, string stepId = null, long? durationMs = null) =>
            Track("step", new Dictionary<string, object> { ["flow"] = flow, ["step"] = step, ["step_id"] = stepId, ["duration_ms"] = durationMs });

        static Dictionary<string, object> EndProps(Dictionary<string, object> start, PlayResult result, long durationMs) =>
            new Dictionary<string, object>(start)
            {
                ["result"] = result.ToString().ToLowerInvariant(),
                ["duration_ms"] = durationMs,
            };

        static long ElapsedMs(OpenPlay play) => (long)(Math.Max(0, Clock() - play.Start) * 1000);

        // Saved as a JSON string array: session id, elapsed ms, save time (unix ms), then key and typed value pairs.
        static void SavePlay()
        {
            if (openPlay == null)
            {
                PlayerPrefs.DeleteKey(PlayKey);
                return;
            }
            var sb = new StringBuilder("[");
            Json.String(sb, openPlay.SessionId);
            sb.Append(',');
            Json.String(sb, ElapsedMs(openPlay).ToString(Inv));
            sb.Append(',');
            Json.String(sb, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds().ToString(Inv));
            foreach (var kv in openPlay.Props)
            {
                if (kv.Key == null || !Json.CanWrite(kv.Value)) continue;
                sb.Append(',');
                Json.String(sb, kv.Key);
                sb.Append(',');
                Json.String(sb, Typed(kv.Value));
            }
            PlayerPrefs.SetString(PlayKey, sb.Append(']').ToString());
        }

        /// <summary>Called once per launch when the queue loads: a play saved by the last run ends as abandon.</summary>
        static void RecoverOpenPlay()
        {
            var list = Json.ParseStringArray(PlayerPrefs.GetString(PlayKey));
            if (list == null || list.Count < 3 || list.Count % 2 != 1
                || !long.TryParse(list[1], NumberStyles.Integer, Inv, out long elapsed)
                || !long.TryParse(list[2], NumberStyles.Integer, Inv, out long savedAt)) return;
            var props = new Dictionary<string, object>();
            for (int i = 3; i < list.Count; i += 2) props[list[i]] = Untyped(list[i + 1]);
            var p = EndProps(props, PlayResult.Abandon, elapsed);
            // ts is the last save, the closest known moment to the end. The fixed event_id lets the server
            // drop a second copy if the app dies again before the next Save removes the saved play.
            queue.Enqueue(EventBuilder.Build("play_end", p, list[0], savedAt, list[0] + ":abandon"));
        }

        static string Typed(object v)
        {
            switch (v)
            {
                case string s: return "s" + s;
                case bool b: return b ? "b1" : "b0";
                // The same number types Json.Value writes as numbers; anything else is written as text there too.
                case double d: return "n" + d.ToString("R", Inv);
                case float f: return "n" + f.ToString("R", Inv);
                case int _: case long _: case short _: case byte _: case sbyte _: case uint _: case ulong _: case ushort _: case decimal _:
                    return "n" + Convert.ToString(v, Inv);
                default: return "s" + v;
            }
        }

        static object Untyped(string s)
        {
            if (s.Length == 0) return "";
            switch (s[0])
            {
                case 'b': return s == "b1";
                case 'n':
                    string n = s.Substring(1);
                    if (long.TryParse(n, NumberStyles.Integer, Inv, out long l)) return l;
                    return double.TryParse(n, NumberStyles.Float, Inv, out double d) ? (object)d : n;
                default: return s.Substring(1);
            }
        }
    }
}
