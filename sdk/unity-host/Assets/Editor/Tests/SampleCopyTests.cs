using System.IO;
using NUnit.Framework;
using UnityEditor.PackageManager;

public class SampleCopyTests
{
    // Assets/*Check folders hold copies of the samples because Unity never compiles Samples~.
    // This keeps the copies honest: copy a sample again when it changes.
    [TestCase("NinjaSmash/IdolyticsAnalyticsService.cs", "NinjaSmashCheck")]
    [TestCase("MatchBattle/MatchBattleAnalytics.cs", "MatchBattleCheck")]
    public void SampleCopyMatchesSample(string sample, string copyFolder)
    {
        string package = PackageInfo.FindForAssetPath("Packages/com.idolytics.unity").resolvedPath;
        string original = File.ReadAllText(Path.Combine(package, "Samples~", sample));
        string copy = File.ReadAllText(Path.Combine("Assets", copyFolder, Path.GetFileName(sample)));
        Assert.AreEqual(original, copy, $"Copy Samples~/{sample} to Assets/{copyFolder}/.");
    }
}
