using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text;

namespace IdolyticsSdk
{
    /// <summary>The little JSON the SDK needs: write strings and flat values, read back an array of strings.</summary>
    internal static class Json
    {
        static readonly CultureInfo Inv = CultureInfo.InvariantCulture;

        public static void String(StringBuilder sb, string s)
        {
            sb.Append('"');
            foreach (char c in s)
            {
                switch (c)
                {
                    case '"': sb.Append("\\\""); break;
                    case '\\': sb.Append("\\\\"); break;
                    case '\n': sb.Append("\\n"); break;
                    case '\r': sb.Append("\\r"); break;
                    case '\t': sb.Append("\\t"); break;
                    default:
                        if (c < 0x20) sb.Append("\\u").Append(((int)c).ToString("x4", Inv));
                        else sb.Append(c);
                        break;
                }
            }
            sb.Append('"');
        }

        /// <summary>False for null, NaN and Infinity, which JSON cannot carry; the caller drops the key.</summary>
        public static bool CanWrite(object v)
        {
            if (v is double d) return !double.IsNaN(d) && !double.IsInfinity(d);
            if (v is float f) return !float.IsNaN(f) && !float.IsInfinity(f);
            return v != null;
        }

        /// <summary>Writes a string, bool or number; anything else as its ToString().</summary>
        public static void Value(StringBuilder sb, object v)
        {
            switch (v)
            {
                case string s: String(sb, s); break;
                case bool b: sb.Append(b ? "true" : "false"); break;
                case double d: sb.Append(d.ToString("R", Inv)); break;
                case float f: sb.Append(f.ToString("R", Inv)); break;
                case int _: case long _: case short _: case byte _: case sbyte _: case uint _: case ulong _: case ushort _: case decimal _:
                    sb.Append(Convert.ToString(v, Inv)); break;
                default: String(sb, v.ToString()); break;
            }
        }

        /// <summary>Parses a JSON array of strings; null when the text is anything else.</summary>
        public static List<string> ParseStringArray(string s)
        {
            if (string.IsNullOrEmpty(s)) return null;
            int i = 0;
            var list = new List<string>();
            SkipSpace(s, ref i);
            if (i >= s.Length || s[i++] != '[') return null;
            SkipSpace(s, ref i);
            if (i < s.Length && s[i] == ']') return list;
            while (true)
            {
                SkipSpace(s, ref i);
                string item = ParseString(s, ref i);
                if (item == null) return null;
                list.Add(item);
                SkipSpace(s, ref i);
                if (i >= s.Length) return null;
                char c = s[i++];
                if (c == ']') return list;
                if (c != ',') return null;
            }
        }

        static void SkipSpace(string s, ref int i)
        {
            while (i < s.Length && char.IsWhiteSpace(s[i])) i++;
        }

        static string ParseString(string s, ref int i)
        {
            if (i >= s.Length || s[i++] != '"') return null;
            var sb = new StringBuilder();
            while (i < s.Length)
            {
                char c = s[i++];
                if (c == '"') return sb.ToString();
                if (c != '\\') { sb.Append(c); continue; }
                if (i >= s.Length) return null;
                char e = s[i++];
                switch (e)
                {
                    case '"': case '\\': case '/': sb.Append(e); break;
                    case 'n': sb.Append('\n'); break;
                    case 'r': sb.Append('\r'); break;
                    case 't': sb.Append('\t'); break;
                    case 'b': sb.Append('\b'); break;
                    case 'f': sb.Append('\f'); break;
                    case 'u':
                        if (i + 4 > s.Length || !ushort.TryParse(s.Substring(i, 4), NumberStyles.HexNumber, Inv, out ushort u)) return null;
                        sb.Append((char)u);
                        i += 4;
                        break;
                    default: return null;
                }
            }
            return null;
        }
    }
}
