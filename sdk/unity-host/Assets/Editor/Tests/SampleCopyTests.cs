using System.IO;
using NUnit.Framework;
using UnityEditor.PackageManager;

public class SampleCopyTests
{
    // Assets/NinjaSmashCheck holds a copy of the sample because Unity never compiles Samples~.
    // This keeps the copy honest: copy the sample again when it changes.
    [Test]
    public void NinjaSmashAdapterCopyMatchesSample()
    {
        string package = PackageInfo.FindForAssetPath("Packages/com.idolytics.unity").resolvedPath;
        string sample = File.ReadAllText(Path.Combine(package, "Samples~/NinjaSmash/IdolyticsAnalyticsService.cs"));
        string copy = File.ReadAllText("Assets/NinjaSmashCheck/IdolyticsAnalyticsService.cs");
        Assert.AreEqual(sample, copy, "Copy Samples~/NinjaSmash/IdolyticsAnalyticsService.cs to Assets/NinjaSmashCheck/.");
    }
}
