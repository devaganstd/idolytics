using System;
using System.Collections.Generic;
using System.Text;

namespace IdolyticsSdk
{
    /// <summary>
    /// FIFO of serialized event JSON, capped by count and by UTF-8 bytes; the oldest event is
    /// dropped when full. Plain C# so it is EditMode testable.
    /// </summary>
    internal class EventQueue
    {
        // Keeps the persisted queue well under the 1 MB PlayerPrefs limit on WebGL, escaping included.
        public const int DefaultMaxBytes = 256 * 1024;

        readonly List<string> items = new List<string>();
        readonly int capacity;
        readonly int maxBytes;

        public EventQueue(int capacity = 1000, int maxBytes = DefaultMaxBytes)
        {
            this.capacity = capacity;
            this.maxBytes = maxBytes;
        }

        public int Count => items.Count;

        /// <summary>UTF-8 size of all queued events.</summary>
        public int Bytes { get; private set; }

        /// <summary>How many events were dropped from the front because the queue was full.</summary>
        public long Dropped { get; private set; }

        public void Enqueue(string eventJson)
        {
            items.Add(eventJson);
            Bytes += Encoding.UTF8.GetByteCount(eventJson);
            // Always keeps the newest event, even one larger than maxBytes on its own.
            while (items.Count > 1 && (items.Count > capacity || Bytes > maxBytes))
            {
                Remove(1);
                Dropped++;
            }
        }

        public IReadOnlyList<string> Peek(int max) => items.GetRange(0, Math.Min(max, items.Count));

        /// <summary>Acks the first <paramref name="count"/> events.</summary>
        public void Remove(int count)
        {
            count = Math.Min(count, items.Count);
            for (int i = 0; i < count; i++) Bytes -= Encoding.UTF8.GetByteCount(items[i]);
            items.RemoveRange(0, count);
        }

        /// <summary>A JSON array of strings.</summary>
        public string Serialize()
        {
            var sb = new StringBuilder("[");
            for (int i = 0; i < items.Count; i++)
            {
                if (i > 0) sb.Append(',');
                Json.String(sb, items[i]);
            }
            return sb.Append(']').ToString();
        }

        /// <summary>
        /// Never throws: unreadable data gives an empty queue and sets <paramref name="unreadable"/>.
        /// Null or empty data (nothing saved yet) is not unreadable.
        /// </summary>
        public static EventQueue Restore(string data, int capacity, out bool unreadable)
        {
            var q = new EventQueue(capacity);
            var list = Json.ParseStringArray(data);
            unreadable = list == null && !string.IsNullOrEmpty(data);
            if (list != null) foreach (var s in list) q.Enqueue(s);
            return q;
        }
    }
}
