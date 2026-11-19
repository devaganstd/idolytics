using System;
using System.Collections;
using System.Collections.Generic;
using System.Text;
using UnityEngine;
using UnityEngine.Networking;

namespace IdolyticsSdk
{
    /// <summary>
    /// Hidden component that posts one batch at a time with UnityWebRequest from a coroutine
    /// (no threads, so it runs on WebGL), and starts a new session after 30 s in the background.
    /// </summary>
    internal class IdolyticsSender : MonoBehaviour
    {
        const float MaxBackoff = 300;
        const long SessionTimeoutMs = 30000;
        // The server accepts at most 100 events and 64 KB per request; the byte cap leaves headroom.
        internal const int MaxEvents = 100;
        internal const int MaxBytes = 60 * 1024;

        internal float backoff;
        internal int maxBatch = MaxEvents;
        bool sending;
        bool warnedRejected;
        long backgroundSince = -1;

        IEnumerator Start()
        {
            while (true)
            {
                yield return null;
                var settings = Idolytics.Settings;
                float until = Time.realtimeSinceStartup + (backoff > 0 ? backoff : settings.flushIntervalSeconds);
                while (Time.realtimeSinceStartup < until && (backoff > 0 || Idolytics.Queue.Count < settings.batchSize))
                    yield return null;
                if (!sending) yield return Send();
            }
        }

        void Update()
        {
            if (Idolytics.Dirty || Idolytics.PlayOpen) Idolytics.SaveThrottled();
        }

        public void Flush()
        {
            // StartCoroutine runs Send up to SendWebRequest right away, so this works from pause and quit.
            if (!sending) StartCoroutine(Send());
        }

        // Send never throws: an exception would end the Start loop that yields to it.
        IEnumerator Send()
        {
            if (!Idolytics.CanSend || Idolytics.Queue.Count == 0) yield break;
            sending = true;
            UnityWebRequest req = null;
            try
            {
                IReadOnlyList<string> batch = null;
                long droppedBefore = Idolytics.Queue.Dropped;
                try
                {
                    batch = NextBatch();
                    req = Request(batch);
                }
                catch (Exception e)
                {
                    Debug.LogException(e);
                }
                if (req == null) yield break;

                yield return req.SendWebRequest();

                try
                {
                    // Events of this batch that a full queue already dropped while the request was in flight.
                    int sent = batch.Count - (int)Math.Min(batch.Count, Idolytics.Queue.Dropped - droppedBefore);
                    if (OnResponse(req.responseCode, batch.Count, req.downloadHandler.text)) Idolytics.Queue.Remove(sent);
                    Idolytics.Save();
                }
                catch (Exception e)
                {
                    Debug.LogException(e);
                }
            }
            finally
            {
                req?.Dispose();
                sending = false;
            }
        }

        IReadOnlyList<string> NextBatch()
        {
            var candidates = Idolytics.Queue.Peek(Math.Max(1, Math.Min(Idolytics.Settings.batchSize, maxBatch)));
            int overhead = Encoding.UTF8.GetByteCount(Idolytics.Envelope(Array.Empty<string>()));
            return Idolytics.Queue.Peek(Fit(candidates, MaxBytes - overhead));
        }

        static UnityWebRequest Request(IReadOnlyList<string> batch)
        {
            var settings = Idolytics.Settings;
            var req = new UnityWebRequest(settings.endpoint.TrimEnd('/') + "/v1/events", "POST");
            req.uploadHandler = new UploadHandlerRaw(Encoding.UTF8.GetBytes(Idolytics.Envelope(batch)));
            req.downloadHandler = new DownloadHandlerBuffer();
            req.SetRequestHeader("Authorization", "Bearer " + settings.writeKey);
            req.SetRequestHeader("Content-Type", "application/json");
            return req;
        }

        /// <summary>How many leading events fit in <paramref name="budget"/> UTF-8 bytes; at least one.</summary>
        internal static int Fit(IReadOnlyList<string> events, int budget)
        {
            int n = 0;
            for (; n < events.Count; n++)
            {
                budget -= Encoding.UTF8.GetByteCount(events[n]) + 1; // + the comma
                if (budget < 0) break;
            }
            return Math.Max(1, n);
        }

        /// <summary>Applies the server's answer to the retry state. True when the batch leaves the queue.</summary>
        internal bool OnResponse(long code, int batchCount, string body)
        {
            if (code >= 200 && code < 300)
            {
                backoff = 0;
                maxBatch = MaxEvents;
                return true;
            }
            if (code == 400 || code == 413)
            {
                // Retry in halves until one event is left, then drop only that event.
                if (batchCount > 1)
                {
                    maxBatch = batchCount / 2;
                    return false;
                }
                Warn(code, body);
                return true;
            }
            // 401/403 (wrong write key), 404, 408, 429, 5xx and network errors: keep the queue, back off.
            if (code >= 400 && code < 500) Warn(code, body);
            backoff = backoff > 0 ? Mathf.Min(backoff * 2, MaxBackoff) : 2;
            return false;
        }

        void Warn(long code, string body)
        {
            if (warnedRejected) return;
            warnedRejected = true;
            Debug.LogWarning("[idolytics] Server answered HTTP " + code + "; check endpoint and write key. " + body);
        }

        void OnApplicationPause(bool paused)
        {
            if (paused) Background();
            else Foreground();
        }

        void OnApplicationFocus(bool focused)
        {
            if (focused) Foreground();
            else Background();
        }

        void OnApplicationQuit()
        {
            Idolytics.Save();
            Flush();
        }

        void Background()
        {
            if (backgroundSince >= 0) return;
            backgroundSince = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            Idolytics.Save();
            Flush();
        }

        void Foreground()
        {
            if (backgroundSince < 0) return;
            if (DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() - backgroundSince > SessionTimeoutMs) Idolytics.StartSession();
            backgroundSince = -1;
        }
    }
}
