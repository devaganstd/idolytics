using System.Collections.Generic;
using IdolyticsSdk;
using UnityEngine;

/// <summary>Sends one test event on start. Used by the sample scene and the WebGL build check.</summary>
public class SendTestEvent : MonoBehaviour
{
    void Start()
    {
        Idolytics.Track("sdk_test", new Dictionary<string, object> { { "level", "1" }, { "source", "unity-host" } });
        Debug.Log("[idolytics-host] Tracked sdk_test.");
    }
}
