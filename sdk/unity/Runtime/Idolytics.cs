using System;
using System.Collections.Generic;
using System.Text;
using UnityEngine;

namespace IdolyticsSdk
{
    /// <summary>
    /// The SDK entry point. Track queues an event (persisted in PlayerPrefs); a hidden sender
    /// posts batches to the server once settings are known.
    /// </summary>
    public static class Idolytics
    {
        internal const string SdkVersion = "unity/0.1.1";
        const string InstallIdKey = "idolytics.install_id";
        const string QueueKey = "idolytics.queue";
        const float SaveInterval = 2;

        internal static IdolyticsSettings Settings;
        static IdolyticsSender sender;
        static EventQueue queue;
        static string installId;
        static float lastSave = float.NegativeInfinity;

        /// <summary>True when events were queued since the last save.</summary>
        internal static bool Dirty { get; private set; }

        public static string SessionId { get; private set; }

        public static string InstallId
        {
            get
            {
                if (string.IsNullOrEmpty(installId))
                {
                    installId = PlayerPrefs.GetString(InstallIdKey);
                    if (string.IsNullOrEmpty(installId))
                    {
                        installId = Guid.NewGuid().ToString();
                        PlayerPrefs.SetString(InstallIdKey, installId);
                        PlayerPrefs.Save();
                    }
                }
                return installId;
            }
        }

        internal static EventQueue Queue
        {
            get
            {
                if (queue == null)
                {
                    queue = EventQueue.Restore(PlayerPrefs.GetString(QueueKey), 1000, out bool unreadable);
                    if (unreadable) Debug.LogWarning("[idolytics] The saved event queue was unreadable and was discarded.");
                }
                return queue;
            }
        }

        internal static bool CanSend =>
            Settings != null && !string.IsNullOrEmpty(Settings.endpoint) && (!Application.isEditor || Settings.sendInEditor);

        /// <summary>Optional: overrides the Resources/IdolyticsSettings asset.</summary>
        public static void Init(IdolyticsSettings settings)
        {
            if (settings == null)
            {
                Debug.LogWarning("[idolytics] Init called with null settings.");
                return;
            }
            Settings = settings;
            if (sender == null)
            {
                var go = new GameObject("idolytics") { hideFlags = HideFlags.HideInHierarchy };
                UnityEngine.Object.DontDestroyOnLoad(go);
                sender = go.AddComponent<IdolyticsSender>();
            }
            if (SessionId == null) StartSession();
        }

        /// <summary>
        /// Queues an event. Props level, attempt, duration_ms, value and currency become event fields;
        /// the rest go to props as string, bool or number. Safe to call before Init.
        /// </summary>
        public static void Track(string name, IDictionary<string, object> props = null)
        {
            if (string.IsNullOrEmpty(name))
            {
                Debug.LogWarning("[idolytics] Track called with an empty event name.");
                return;
            }
            if (SessionId == null) StartSession();
            Enqueue(name, props);
            SaveThrottled();
        }

        /// <summary>Sends the next batch now instead of waiting for the interval.</summary>
        public static void Flush()
        {
            if (sender != null) sender.Flush();
        }

        internal static void StartSession()
        {
            SessionId = Guid.NewGuid().ToString();
            Enqueue("session_start", null);
        }

        static void Enqueue(string name, IDictionary<string, object> props)
        {
            Queue.Enqueue(EventBuilder.Build(name, props, SessionId, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), Guid.NewGuid().ToString()));
        }

        internal static void Save()
        {
            PlayerPrefs.SetString(QueueKey, Queue.Serialize());
            PlayerPrefs.Save();
            lastSave = Time.realtimeSinceStartup;
            Dirty = false;
        }

        /// <summary>
        /// Saves at most once every 2 s; the sender saves the rest when the interval ends. WebGL never
        /// calls OnApplicationQuit, so this bounds what a closed tab loses.
        /// </summary>
        internal static void SaveThrottled()
        {
            if (Time.realtimeSinceStartup - lastSave >= SaveInterval) Save();
            else Dirty = true;
        }

        internal static string Envelope(IReadOnlyList<string> events)
        {
            var sb = new StringBuilder(256 + events.Count * 200);
            sb.Append("{\"schema\":1,\"sdk\":");
            Json.String(sb, SdkVersion);
            sb.Append(",\"device_id\":");
            Json.String(sb, InstallId);
            sb.Append(",\"app_version\":");
            Json.String(sb, Application.version);
            sb.Append(",\"platform\":");
            Json.String(sb, Platform());
            sb.Append(",\"os\":");
            Json.String(sb, SystemInfo.operatingSystem);
            sb.Append(",\"events\":[");
            for (int i = 0; i < events.Count; i++)
            {
                if (i > 0) sb.Append(',');
                sb.Append(events[i]);
            }
            return sb.Append("]}").ToString();
        }

        static string Platform()
        {
            if (Application.isEditor) return "editor";
            switch (Application.platform)
            {
                case RuntimePlatform.Android: return "android";
                case RuntimePlatform.IPhonePlayer: return "ios";
                case RuntimePlatform.WebGLPlayer: return "webgl";
                case RuntimePlatform.WindowsPlayer: return "windows";
                case RuntimePlatform.OSXPlayer: return "osx";
                case RuntimePlatform.LinuxPlayer: return "linux";
                default: return Application.platform.ToString().ToLowerInvariant();
            }
        }

        [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.AfterSceneLoad)]
        static void AutoInit()
        {
            if (Settings != null) return;
            var settings = Resources.Load<IdolyticsSettings>("IdolyticsSettings");
            if (settings == null)
            {
                Debug.LogWarning("[idolytics] No Resources/IdolyticsSettings asset; events are queued but not sent until Idolytics.Init(settings) is called.");
                return;
            }
            Init(settings);
        }

        // Statics survive play mode in the Editor when domain reload is off.
        [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.SubsystemRegistration)]
        static void ResetStatics()
        {
            Settings = null;
            sender = null;
            queue = null;
            SessionId = null;
            lastSave = float.NegativeInfinity;
            Dirty = false;
        }
    }
}
