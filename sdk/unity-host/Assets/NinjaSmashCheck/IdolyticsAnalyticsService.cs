// Ninja Smash adapter for idolytics.
//
// This file belongs in the game, not in the package. To install it:
//   1. Copy it into the game's Scripts/Services folder.
//   2. Add "Idolytics" to the references of the NinjaSmash.Services asmdef.
//   3. Create the asset (Create > Ninja Smash > Service > Idolytics Analytics) and assign an
//      IdolyticsSettings asset (Create > idolytics > Settings) with your endpoint and write key.
//   4. In the boot config, swap Service_FakeAnalytics for this asset.
//
// It is also the reference example of an adapter for other games: implement the game's own
// analytics interface, call Idolytics.Init, and map game events to idolytics events in one place.
//
// duration_ms is scaled game time (Time.time): it stops while Time.timeScale is 0 (ads, continue
// offers, the Try card) and barely moves while the app is in the background.

using System;
using System.Collections.Generic;
using System.Globalization;
using IdolyticsSdk;
using UnityEngine;

namespace NinjaSmash.Services
{
    [CreateAssetMenu(menuName = "Ninja Smash/Service/Idolytics Analytics", fileName = "Service_IdolyticsAnalytics")]
    public class IdolyticsAnalyticsService : ServiceDefinition, IAnalyticsService
    {
        [SerializeField] IdolyticsSettings settings;

        // Per level: the attempt and start time (Time.time) from its last level_start.
        readonly Dictionary<string, (int attempt, float start)> starts = new Dictionary<string, (int attempt, float start)>();

        public override void Initialize(ServiceContext context, Action<bool> done)
        {
            starts.Clear();
            Idolytics.Init(settings);
            context.Hub.SetAnalytics(this);
            done(true);
        }

        public void Log(string name) => Send(name, null, null, null, null, null, null);

        public void Log(string name, string key, object value) => Send(name, key, value, null, null, null, null);

        public void Log(string name, string key1, object value1, string key2, object value2) =>
            Send(name, key1, value1, key2, value2, null, null);

        public void Log(string name, string key1, object value1, string key2, object value2, string key3, object value3) =>
            Send(name, key1, value1, key2, value2, key3, value3);

        // The whole mapping (idolytics plan, decision 8).
        void Send(string name, string key1, object value1, string key2, object value2, string key3, object value3)
        {
            var p = new Dictionary<string, object>();
            if (key1 != null) p[key1] = value1;
            if (key2 != null) p[key2] = value2;
            if (key3 != null) p[key3] = value3;
            // No level: no attempt or duration, since they are keyed by level.
            string level = p.TryGetValue("level", out object l) && l != null ? Convert.ToString(l, CultureInfo.InvariantCulture) : null;

            switch (name)
            {
                case "level_start":
                    if (level == null) break;
                    int attempt = p.TryGetValue("attempt", out object a) && int.TryParse(Convert.ToString(a, CultureInfo.InvariantCulture),
                        NumberStyles.Integer, CultureInfo.InvariantCulture, out int n) ? n : 0;
                    starts[level] = (attempt, Time.time);
                    break;
                case "level_win":
                    name = "level_complete";
                    Move(p, "throws_left", "moves_left");
                    AddAttemptAndDuration(p, level);
                    break;
                case "level_lose":
                    name = "level_fail";
                    Move(p, "pieces_left", "targets_left");
                    p["reason"] = "out_of_moves";
                    AddAttemptAndDuration(p, level);
                    break;
                case "name_set":
                    p.Clear(); // privacy: never send the player's name
                    break;
            }
            Idolytics.Track(name, p);
        }

        void AddAttemptAndDuration(Dictionary<string, object> p, string level)
        {
            if (level == null || !starts.TryGetValue(level, out var start)) return;
            starts.Remove(level);
            p["attempt"] = start.attempt;
            p["duration_ms"] = (long)(Math.Max(0, Time.time - start.start) * 1000);
        }

        static void Move(Dictionary<string, object> p, string from, string to)
        {
            if (!p.TryGetValue(from, out object v)) return;
            p.Remove(from);
            p[to] = v;
        }
    }
}
