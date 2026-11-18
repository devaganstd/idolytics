using UnityEngine;

namespace IdolyticsSdk
{
    /// <summary>Where and how to send events. Put one at Resources/IdolyticsSettings, or pass one to Idolytics.Init.</summary>
    [CreateAssetMenu(menuName = "idolytics/Settings", fileName = "IdolyticsSettings")]
    public class IdolyticsSettings : ScriptableObject
    {
        [Tooltip("Base URL of your idolytics server, e.g. https://x.workers.dev. Events go to <endpoint>/v1/events.")]
        public string endpoint;

        [Tooltip("The project's write key (idl_w_...).")]
        public string writeKey;

        [Tooltip("Off queues events in the Editor without sending them.")]
        public bool sendInEditor = true;

        public float flushIntervalSeconds = 10;

        public int batchSize = 50;
    }
}
