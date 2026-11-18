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

            var restored = EventQueue.Restore(q.Serialize(), 1000, out _);

            CollectionAssert.AreEqual(items, restored.Peek(10));
        }

        [Test]
        public void RestoreKeepsCapacity()
        {
            var q = new EventQueue();
            q.Enqueue("a");
            q.Enqueue("b");
            q.Enqueue("c");

            CollectionAssert.AreEqual(new[] { "b", "c" }, EventQueue.Restore(q.Serialize(), 2, out _).Peek(10));
        }

        [TestCase(null)]
        [TestCase("")]
        [TestCase("garbage")]
        [TestCase("[\"unterminated")]
        [TestCase("[1,2]")]
        [TestCase("[\"a\" \"b\"]")]
        public void RestoreOfBadDataReturnsEmptyQueue(string data)
        {
            var q = EventQueue.Restore(data, 1000, out bool unreadable);
            Assert.AreEqual(0, q.Count);
            Assert.AreEqual(!string.IsNullOrEmpty(data), unreadable);
        }

        [Test]
        public void ByteCapDropsOldestButKeepsNewest()
        {
            var q = new EventQueue(1000, 10);
            q.Enqueue("aaaa");
            q.Enqueue("bbbb");
            q.Enqueue("cccc");

            CollectionAssert.AreEqual(new[] { "bbbb", "cccc" }, q.Peek(10));
            Assert.AreEqual(8, q.Bytes);
            Assert.AreEqual(1, q.Dropped);

            q.Enqueue("this one is larger than the cap");
            Assert.AreEqual(1, q.Count);
            q.Remove(1);
            Assert.AreEqual(0, q.Bytes);
        }

        [Test]
        public void BytesCountUtf8()
        {
            var q = new EventQueue();
            q.Enqueue("é日");
            Assert.AreEqual(5, q.Bytes);
        }
    }

    public class IdolyticsSenderTests
    {
        UnityEngine.GameObject go;
        IdolyticsSender sender;

        [SetUp]
        public void SetUp()
        {
            go = new UnityEngine.GameObject("sender-test");
            sender = go.AddComponent<IdolyticsSender>();
        }

        [TearDown]
        public void TearDown() => UnityEngine.Object.DestroyImmediate(go);

        [Test]
        public void FitStopsAtByteBudgetAndKeepsAtLeastOne()
        {
            var events = new[] { "aaaa", "bbbb", "cccc" };
            Assert.AreEqual(2, IdolyticsSender.Fit(events, 10));
            Assert.AreEqual(3, IdolyticsSender.Fit(events, 15));
            Assert.AreEqual(1, IdolyticsSender.Fit(events, 2));
        }

        [Test]
        public void SuccessAcksAndRestoresBatchSize()
        {
            sender.maxBatch = 12;
            sender.backoff = 8;
            Assert.IsTrue(sender.OnResponse(200, 12, ""));
            Assert.AreEqual(IdolyticsSender.MaxEvents, sender.maxBatch);
            Assert.AreEqual(0, sender.backoff);
        }

        [TestCase(400)]
        [TestCase(413)]
        public void RejectedBatchIsHalvedThenOnlyOneEventDropped(long code)
        {
            Assert.IsFalse(sender.OnResponse(code, 100, ""));
            Assert.AreEqual(50, sender.maxBatch);
            Assert.IsFalse(sender.OnResponse(code, 2, ""));
            Assert.AreEqual(1, sender.maxBatch);
            Assert.IsTrue(sender.OnResponse(code, 1, ""));
            Assert.AreEqual(0, sender.backoff);
        }

        [TestCase(401)]
        [TestCase(403)]
        [TestCase(429)]
        [TestCase(500)]
        [TestCase(0)]
        public void OtherFailuresKeepTheQueueAndBackOff(long code)
        {
            Assert.IsFalse(sender.OnResponse(code, 1, ""));
            Assert.AreEqual(2, sender.backoff);
            Assert.IsFalse(sender.OnResponse(code, 1, ""));
            Assert.AreEqual(4, sender.backoff);
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
        public void NegativeDurationIsLeftOut()
        {
            Assert.AreEqual(
                "{\"event_id\":\"e1\",\"name\":\"x\",\"ts\":1,\"session_id\":\"s1\"}",
                EventBuilder.Build("x", new Dictionary<string, object> { { "duration_ms", -5L } }, "s1", 1, "e1"));
        }

        [Test]
        public void LongPropStringsAreCutTo100WithoutSplittingPairs()
        {
            string json = EventBuilder.Build("x", new Dictionary<string, object>
            {
                { "a", new string('a', 150) },
                { "b", new string('b', 99) + "😀" },
            }, "s1", 1, "e1");

            StringAssert.Contains("\"a\":\"" + new string('a', 100) + "\"", json);
            StringAssert.Contains("\"b\":\"" + new string('b', 99) + "\"", json);
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
