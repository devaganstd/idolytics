using System;
using System.Collections;
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

        float backoff;
        int maxBatch = int.MaxValue;
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

        public void Flush()
        {
            // StartCoroutine runs Send up to SendWebRequest right away, so this works from pause and quit.
            if (!sending) StartCoroutine(Send());
        }

        IEnumerator Send()
        {
            if (!Idolytics.CanSend || Idolytics.Queue.Count == 0) yield break;
            sending = true;
            var settings = Idolytics.Settings;
            var batch = Idolytics.Queue.Peek(Math.Max(1, Math.Min(settings.batchSize, maxBatch)));
            long droppedBefore = Idolytics.Queue.Dropped;
            using (var req = new UnityWebRequest(settings.endpoint.TrimEnd('/') + "/v1/events", "POST"))
            {
                req.uploadHandler = new UploadHandlerRaw(Encoding.UTF8.GetBytes(Idolytics.Envelope(batch)));
                req.downloadHandler = new DownloadHandlerBuffer();
                req.SetRequestHeader("Authorization", "Bearer " + settings.writeKey);
                req.SetRequestHeader("Content-Type", "application/json");
                yield return req.SendWebRequest();

                long code = req.responseCode;
                // Events of this batch that a full queue already dropped while the request was in flight.
                int sent = batch.Count - (int)Math.Min(batch.Count, Idolytics.Queue.Dropped - droppedBefore);
                if (code >= 200 && code < 300)
                {
                    Idolytics.Queue.Remove(sent);
                    backoff = 0;
                }
                else if (code == 413 && batch.Count > 1)
                {
                    maxBatch = batch.Count / 2; // body over the server limit: retry in smaller batches
                }
                else if (code >= 400 && code < 500 && code != 408 && code != 429)
                {
                    // Rejected as a whole; it would never succeed, so drop it.
                    Idolytics.Queue.Remove(sent);
                    if (!warnedRejected)
                    {
                        warnedRejected = true;
                        Debug.LogWarning("[idolytics] Server rejected a batch with HTTP " + code + "; check endpoint and write key. " + req.downloadHandler.text);
                    }
                }
                else
                {
                    backoff = backoff > 0 ? Mathf.Min(backoff * 2, MaxBackoff) : 2;
                }
            }
            Idolytics.Save();
            sending = false;
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
