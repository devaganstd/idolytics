using System;
using System.Collections.Generic;
using System.Globalization;
using System.Runtime.CompilerServices;
using System.Text;

[assembly: InternalsVisibleTo("Idolytics.Tests.Editor")]

namespace IdolyticsSdk
{
    /// <summary>Turns a Track call into one event JSON object. Pure, so it is EditMode testable.</summary>
    internal static class EventBuilder
    {
        static readonly CultureInfo Inv = CultureInfo.InvariantCulture;

        /// <summary>The server rejects an event with a longer prop string, so longer ones are cut.</summary>
        internal const int MaxPropString = 100;

        public static string Build(string name, IDictionary<string, object> props, string sessionId, long ts, string eventId)
        {
            var sb = new StringBuilder(160);
            sb.Append("{\"event_id\":");
            Json.String(sb, eventId);
            sb.Append(",\"name\":");
            Json.String(sb, name);
            sb.Append(",\"ts\":").Append(ts.ToString(Inv));
            sb.Append(",\"session_id\":");
            Json.String(sb, sessionId);

            if (props != null)
            {
                // Reserved props become top level fields; one that cannot be converted stays in props.
                var lifted = new List<string>(5);
                if (props.TryGetValue("level", out object level) && level != null)
                {
                    sb.Append(",\"level\":");
                    Json.String(sb, Convert.ToString(level, Inv));
                    lifted.Add("level");
                }
                if (Number(props, "attempt", lifted, out double attempt)) sb.Append(",\"attempt\":").Append(((int)attempt).ToString(Inv));
                // A negative duration (clock change, bad game math) is sent as no duration; the server rejects it.
                if (Number(props, "duration_ms", lifted, out double duration) && duration >= 0) sb.Append(",\"duration_ms\":").Append(((long)duration).ToString(Inv));
                if (Number(props, "value", lifted, out double value)) sb.Append(",\"value\":").Append(value.ToString("R", Inv));
                if (props.TryGetValue("currency", out object currency) && currency != null)
                {
                    sb.Append(",\"currency\":");
                    Json.String(sb, Convert.ToString(currency, Inv));
                    lifted.Add("currency");
                }

                bool first = true;
                foreach (var kv in props)
                {
                    if (kv.Key == null || lifted.Contains(kv.Key) || !Json.CanWrite(kv.Value)) continue;
                    sb.Append(first ? ",\"props\":{" : ",");
                    first = false;
                    Json.String(sb, kv.Key);
                    sb.Append(':');
                    Json.Value(sb, kv.Value, MaxPropString);
                }
                if (!first) sb.Append('}');
            }
            return sb.Append('}').ToString();
        }

        static bool Number(IDictionary<string, object> props, string key, List<string> lifted, out double d)
        {
            d = 0;
            if (!props.TryGetValue(key, out object v) || v == null) return false;
            try { d = Convert.ToDouble(v, Inv); }
            catch (Exception) { return false; }
            if (double.IsNaN(d) || double.IsInfinity(d)) return false;
            lifted.Add(key);
            return true;
        }
    }
}
