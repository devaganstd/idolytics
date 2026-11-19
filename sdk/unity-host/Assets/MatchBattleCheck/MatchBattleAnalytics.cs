// Match game adapter for idolytics: a generic example for a 1v1 match game against a bot.
//
// It shows how a match game maps its moments onto plays, progression tracks and flow steps
// (SDK 0.2.0). It does not depend on any real game: call these methods from your own match,
// trophy and tutorial events, and rename the enums to your game's types.
//
// Events per match: play_start, play_end and, when trophies change, progress. That stays within
// the 2 to 5 events per play the dashboard is designed for. In-match detail goes into play_end as
// counts, never as a stream of events.

using System.Collections.Generic;
using IdolyticsSdk;

namespace MatchBattleSample
{
    public enum MatchOutcome { Victory, Defeat, Draw, Surrendered }

    public static class MatchBattleAnalytics
    {
        /// <summary>Call when the match starts. <paramref name="deck"/> is sent as one comma separated dimension.</summary>
        public static void MatchStarted(string board, string mode, string botDifficulty, IEnumerable<string> deck)
        {
            Idolytics.PlayStart(board, kind: "match", mode: mode, difficulty: botDifficulty, props: new()
            {
                ["opponent"] = "bot",
                ["deck"] = string.Join(",", deck),
            });
        }

        /// <summary>Call once when the match ends. <paramref name="ownedPercent"/> (0 to 1) is the score.</summary>
        public static void MatchEnded(MatchOutcome outcome, string endReason, double ownedPercent,
            int cardsDeployed, int merges, int spellsCast, int towersLost)
        {
            Idolytics.PlayEnd(Result(outcome), score: ownedPercent, reason: endReason, props: new()
            {
                ["cards_deployed"] = cardsDeployed,
                ["merges"] = merges,
                ["spells_cast"] = spellsCast,
                ["towers_lost"] = towersLost,
            });
        }

        /// <summary>Call after the trophy count changes, and with the new arena when it changes.</summary>
        public static void TrophiesChanged(int trophies, int delta, int? newArena = null)
        {
            Idolytics.Progress("trophies", trophies, delta);
            if (newArena.HasValue) Idolytics.Progress("arena", newArena.Value);
        }

        /// <summary>Call when the player completes a tutorial step.</summary>
        public static void TutorialStepCompleted(string flow, int step, string stepId, float secondsInStep)
        {
            Idolytics.Step(flow, step, stepId, (long)(secondsInStep * 1000));
        }

        static PlayResult Result(MatchOutcome outcome)
        {
            switch (outcome)
            {
                case MatchOutcome.Victory: return PlayResult.Win;
                case MatchOutcome.Defeat: return PlayResult.Loss;
                case MatchOutcome.Draw: return PlayResult.Draw;
                default: return PlayResult.Quit; // the player surrendered on purpose
            }
        }
    }
}
