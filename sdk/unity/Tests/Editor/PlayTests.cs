using System.Collections.Generic;
using System.Linq;
using NUnit.Framework;
using UnityEngine;
using UnityEngine.TestTools;

namespace IdolyticsSdk.Tests
{
    public class PlayTests
    {
        const string Board = "idl_test_board";
        const string Other = "idl_test_other";
        static readonly string[] Keys = { "idolytics.queue", "idolytics.play" };
        float clock;
        string[] saved;

        [SetUp]
        public void SetUp()
        {
            // These tests use the Editor's real PlayerPrefs; keep what was there.
            saved = System.Array.ConvertAll(Keys, k => PlayerPrefs.HasKey(k) ? PlayerPrefs.GetString(k) : null);
            Clean();
            Idolytics.Clock = () => clock;
            clock = 0;
        }

        [TearDown]
        public void TearDown()
        {
            Clean();
            for (int i = 0; i < Keys.Length; i++)
                if (saved[i] != null) PlayerPrefs.SetString(Keys[i], saved[i]);
            Idolytics.Clock = () => Time.time;
        }

        static void Clean()
        {
            foreach (var k in Keys) PlayerPrefs.DeleteKey(k);
            PlayerPrefs.DeleteKey("idolytics.attempt." + Board);
            PlayerPrefs.DeleteKey("idolytics.attempt." + Other);
            Idolytics.ResetStatics();
        }

        static List<string> Events(string name) =>
            Idolytics.Queue.Peek(1000).Where(e => e.Contains("\"name\":\"" + name + "\"")).ToList();

        // Simulates the app being killed and launched again: only what was saved survives.
        static void Kill() => Idolytics.ResetStatics();

        [Test]
        public void PlayStartSendsPlayKeyKindModeDifficultyAndProps()
        {
            Idolytics.PlayStart(Board, kind: "match", mode: "normal", difficulty: "easy",
                props: new() { ["opponent"] = "bot", ["deck"] = "burst,canon" });

            string e = Events("play_start").Single();
            StringAssert.Contains("\"level\":\"" + Board + "\"", e);
            StringAssert.Contains("\"attempt\":1", e);
            StringAssert.Contains("\"kind\":\"match\"", e);
            StringAssert.Contains("\"mode\":\"normal\"", e);
            StringAssert.Contains("\"difficulty\":\"easy\"", e);
            StringAssert.Contains("\"opponent\":\"bot\"", e);
            StringAssert.Contains("\"deck\":\"burst,canon\"", e);
        }

        [Test]
        public void AttemptCountsPerPlayKeyAcrossRestartsUnlessTheGamePassesOne()
        {
            Idolytics.PlayStart(Board);
            Idolytics.PlayEnd(PlayResult.Loss);
            Kill();
            Idolytics.PlayStart(Board);
            Idolytics.PlayEnd(PlayResult.Win);
            Idolytics.PlayStart(Board, props: new() { ["attempt"] = 7 });
            Idolytics.PlayEnd(PlayResult.Win);
            Idolytics.PlayStart(Board);

            var starts = Events("play_start");
            StringAssert.Contains("\"attempt\":2", starts[1]);
            StringAssert.Contains("\"attempt\":7", starts[2]);
            StringAssert.Contains("\"attempt\":8", starts[3]);
        }

        [Test]
        public void PlayEndCarriesStartKeysResultDurationAndScore()
        {
            clock = 10;
            Idolytics.PlayStart(Board, kind: "match", mode: "normal", props: new() { ["deck"] = "burst" });
            clock = 12.5f;
            Idolytics.PlayEnd(PlayResult.Win, score: 0.92, reason: "knockout", props: new() { ["cards_deployed"] = 14 });

            string e = Events("play_end").Single();
            StringAssert.Contains("\"level\":\"" + Board + "\"", e);
            StringAssert.Contains("\"attempt\":1", e);
            StringAssert.Contains("\"duration_ms\":2500", e);
            StringAssert.Contains("\"value\":0.92", e);
            StringAssert.Contains("\"kind\":\"match\"", e);
            StringAssert.Contains("\"mode\":\"normal\"", e);
            StringAssert.Contains("\"deck\":\"burst\"", e);
            StringAssert.Contains("\"result\":\"win\"", e);
            StringAssert.Contains("\"reason\":\"knockout\"", e);
            StringAssert.Contains("\"cards_deployed\":14", e);
        }

        [Test]
        public void PlayStartClosesAnOpenPlayAsAbandon()
        {
            clock = 1;
            Idolytics.PlayStart(Board);
            clock = 4;
            Idolytics.PlayStart(Other);

            string e = Events("play_end").Single();
            StringAssert.Contains("\"level\":\"" + Board + "\"", e);
            StringAssert.Contains("\"result\":\"abandon\"", e);
            StringAssert.Contains("\"duration_ms\":3000", e);
            Assert.AreEqual(2, Events("play_start").Count);
        }

        [Test]
        public void PlayLeftOpenAcrossRestartIsSentAsAbandonOnce()
        {
            clock = 5;
            Idolytics.PlayStart(Board, kind: "match", props: new() { ["deck"] = "burst", ["won"] = true });
            string session = Idolytics.SessionId;
            clock = 12.5f;
            Idolytics.Save(); // the sender's periodic save while the play is open
            Kill();
            clock = 0; // a new process starts its clock again

            string e = Events("play_end").Single();
            StringAssert.Contains("\"result\":\"abandon\"", e);
            StringAssert.Contains("\"duration_ms\":7500", e);
            StringAssert.Contains("\"level\":\"" + Board + "\"", e);
            StringAssert.Contains("\"attempt\":1", e);
            StringAssert.Contains("\"kind\":\"match\"", e);
            StringAssert.Contains("\"deck\":\"burst\"", e);
            StringAssert.Contains("\"won\":true", e);
            StringAssert.Contains("\"session_id\":\"" + session + "\"", e);
            StringAssert.Contains("\"event_id\":\"" + session + ":abandon\"", e);

            Idolytics.Save();
            Kill();
            Assert.AreEqual(1, Events("play_end").Count, "the abandon must not be sent again");
            LogAssert.Expect(LogType.Warning, "[idolytics] PlayEnd called with no open play.");
            Idolytics.PlayEnd(PlayResult.Win);
        }

        [Test]
        public void KillRightAfterPlayStartStillSendsAbandon()
        {
            Idolytics.PlayStart(Board);
            Kill();

            StringAssert.Contains("\"result\":\"abandon\"", Events("play_end").Single());
        }

        [Test]
        public void KillRightAfterPlayEndSendsNoAbandon()
        {
            Idolytics.PlayStart(Board);
            Idolytics.PlayEnd(PlayResult.Win);
            Kill();

            StringAssert.Contains("\"result\":\"win\"", Events("play_end").Single());
        }

        [Test]
        public void KillBeforeTheAbandonIsSavedRecoversItWithTheSameEventId()
        {
            Idolytics.PlayStart(Board);
            Kill();
            string first = Events("play_end").Single();
            Kill();
            Assert.AreEqual(first.Substring(0, first.IndexOf(",\"name\"")), Events("play_end").Single().Substring(0, first.IndexOf(",\"name\"")));
        }

        [Test]
        public void PlayEndKeepsTheStartSessionWhenANewSessionBeganMidPlay()
        {
            Idolytics.PlayStart(Board);
            string session = Idolytics.SessionId;
            Idolytics.StartSession();
            Idolytics.PlayEnd(PlayResult.Win);

            StringAssert.Contains("\"session_id\":\"" + session + "\"", Events("play_end").Single());
        }

        [Test]
        public void SavedPlayPropsRoundTrip()
        {
            Idolytics.PlayStart(Board, props: new()
            {
                ["text"] = "q\"uo\te é 日本 😀",
                ["f"] = 0.1f,
                ["big"] = 9007199254740993L,
                ["neg"] = -3,
                ["flag"] = false,
            });
            string start = Events("play_start").Single();
            Kill();
            string end = Events("play_end").Single();

            foreach (var fragment in new[] { "\"text\":", "\"f\":", "\"big\":", "\"neg\":", "\"flag\":" })
            {
                int a = start.IndexOf(fragment), b = end.IndexOf(fragment);
                Assert.That(a >= 0 && b >= 0, fragment);
                string Value(string s, int i) { int from = i + fragment.Length; int to = s.IndexOfAny(new[] { ',', '}' }, from); return s.Substring(from, to - from); }
                Assert.AreEqual(Value(start, a), Value(end, b), fragment);
            }
        }

        [Test]
        public void PlayEndWithoutAnOpenPlaySendsNothing()
        {
            LogAssert.Expect(LogType.Warning, "[idolytics] PlayEnd called with no open play.");
            Idolytics.PlayEnd(PlayResult.Win);
            Assert.AreEqual(0, Events("play_end").Count);
        }

        [Test]
        public void ProgressAndStepEvents()
        {
            Idolytics.Progress("trophies", 330, delta: 30);
            Idolytics.Step("tutorial1", 3, "deploy_first_tower", 4200);

            string p = Events("progress").Single();
            StringAssert.Contains("\"value\":330", p);
            StringAssert.Contains("\"track\":\"trophies\"", p);
            StringAssert.Contains("\"delta\":30", p);

            string s = Events("step").Single();
            StringAssert.Contains("\"duration_ms\":4200", s);
            StringAssert.Contains("\"flow\":\"tutorial1\"", s);
            StringAssert.Contains("\"step\":3", s);
            StringAssert.Contains("\"step_id\":\"deploy_first_tower\"", s);
        }
    }
}
