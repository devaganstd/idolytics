using System;
using System.Collections.Generic;
using System.Text;

namespace IdolyticsSdk
{
    /// <summary>
    /// FIFO of serialized event JSON, capped; the oldest event is dropped when full.
    /// Plain C# so it is EditMode testable.
    /// </summary>
    internal class EventQueue
    {
        readonly List<string> items = new List<string>();
        readonly int capacity;

        public EventQueue(int capacity = 1000)
        {
            this.capacity = capacity;
        }

        public int Count => items.Count;

        /// <summary>How many events were dropped from the front because the queue was full.</summary>
        public long Dropped { get; private set; }

        public void Enqueue(string eventJson)
        {
            if (items.Count >= capacity)
            {
                items.RemoveAt(0);
                Dropped++;
            }
            items.Add(eventJson);
        }

        public IReadOnlyList<string> Peek(int max) => items.GetRange(0, Math.Min(max, items.Count));

        /// <summary>Acks the first <paramref name="count"/> events.</summary>
        public void Remove(int count) => items.RemoveRange(0, Math.Min(count, items.Count));

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

        /// <summary>Never throws: unreadable data gives an empty queue.</summary>
        public static EventQueue Restore(string data, int capacity)
        {
            var q = new EventQueue(capacity);
            var list = Json.ParseStringArray(data);
            if (list != null) foreach (var s in list) q.Enqueue(s);
            return q;
        }
    }
}
