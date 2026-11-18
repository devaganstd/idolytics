using System.Collections.Generic;
using NUnit.Framework;

namespace IdolyticsSdk.Tests
{
    public class EventQueueTests
    {
        [Test]
        public void PeekReturnsEventsInEnqueueOrder()
        {
            var q = new EventQueue();
            q.Enqueue("a");
            q.Enqueue("b");
            q.Enqueue("c");

            Assert.AreEqual(3, q.Count);
            CollectionAssert.AreEqual(new[] { "a", "b" }, q.Peek(2));
            CollectionAssert.AreEqual(new[] { "a", "b", "c" }, q.Peek(10));
        }

        [Test]
        public void RemoveAcksFromFront()
        {
            var q = new EventQueue();
            q.Enqueue("a");
            q.Enqueue("b");
            q.Enqueue("c");

            q.Remove(2);

            Assert.AreEqual(1, q.Count);
            CollectionAssert.AreEqual(new[] { "c" }, q.Peek(10));
        }

        [Test]
        public void FullQueueDropsOldest()
        {
            var q = new EventQueue(2);
            q.Enqueue("a");
            q.Enqueue("b");
            q.Enqueue("c");

            CollectionAssert.AreEqual(new[] { "b", "c" }, q.Peek(10));
            Assert.AreEqual(1, q.Dropped);
        }

        [Test]
        public void SerializeRestoreRoundTripsAnyCharacters()
        {
            var items = new[] { "{\"k\":\"v\"}", "back\\slash", "line\nbreak\r\ttab", "unicode é 日本 😀", "" };
            var q = new EventQueue();
            foreach (var s in items) q.Enqueue(s);

            var restored = EventQueue.Restore(q.Serialize(), 1000);

            CollectionAssert.AreEqual(items, restored.Peek(10));
        }

        [Test]
        public void RestoreKeepsCapacity()
        {
            var q = new EventQueue();
            q.Enqueue("a");
            q.Enqueue("b");
            q.Enqueue("c");

            CollectionAssert.AreEqual(new[] { "b", "c" }, EventQueue.Restore(q.Serialize(), 2).Peek(10));
        }

        [TestCase(null)]
        [TestCase("")]
        [TestCase("garbage")]
        [TestCase("[\"unterminated")]
        [TestCase("[1,2]")]
        [TestCase("[\"a\" \"b\"]")]
        public void RestoreOfBadDataReturnsEmptyQueue(string data)
        {
            Assert.AreEqual(0, EventQueue.Restore(data, 1000).Count);
        }
    }

    public class EventBuilderTests
    {
        [Test]
        public void BuildsMinimalEvent()
        {
            Assert.AreEqual(
                "{\"event_id\":\"e1\",\"name\":\"tap\",\"ts\":1700000000000,\"session_id\":\"s1\"}",
                EventBuilder.Build("tap", null, "s1", 1700000000000L, "e1"));
        }

        [Test]
        public void LiftsReservedPropsAndKeepsTheRest()
        {
            var props = new Dictionary<string, object>
            {
                { "level", 12 },
                { "attempt", 3 },
                { "duration_ms", 4500.7f },
                { "value", 2.5 },
                { "currency", "coins" },
                { "booster", "bomb" },
                { "won", true },
                { "count", 7L },
            };

            Assert.AreEqual(
                "{\"event_id\":\"e1\",\"name\":\"level_complete\",\"ts\":5,\"session_id\":\"s1\"," +
                "\"level\":\"12\",\"attempt\":3,\"duration_ms\":4500,\"value\":2.5,\"currency\":\"coins\"," +
                "\"props\":{\"booster\":\"bomb\",\"won\":true,\"count\":7}}",
                EventBuilder.Build("level_complete", props, "s1", 5, "e1"));
        }

        [Test]
        public void EscapesStringsAndDropsNonFiniteNumbers()
        {
            var props = new Dictionary<string, object>
            {
                { "text", "a\"b\\c\nd\u0001" },
                { "nan", double.NaN },
                { "inf", float.PositiveInfinity },
                { "other", new System.Version(1, 2) },
            };

            Assert.AreEqual(
                "{\"event_id\":\"e1\",\"name\":\"x\",\"ts\":1,\"session_id\":\"s1\"," +
                "\"props\":{\"text\":\"a\\\"b\\\\c\\nd\\u0001\",\"other\":\"1.2\"}}",
                EventBuilder.Build("x", props, "s1", 1, "e1"));
        }

        [Test]
        public void NumbersUseInvariantCulture()
        {
            var old = System.Globalization.CultureInfo.CurrentCulture;
            System.Globalization.CultureInfo.CurrentCulture = new System.Globalization.CultureInfo("de-DE");
            try
            {
                StringAssert.Contains("\"value\":1.5", EventBuilder.Build("x", new Dictionary<string, object> { { "value", 1.5 } }, "s", 1, "e"));
            }
            finally
            {
                System.Globalization.CultureInfo.CurrentCulture = old;
            }
        }
    }
}
