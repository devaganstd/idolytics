// Local copies of the Ninja Smash service types the sample adapter uses, so that
// Samples~/NinjaSmash compiles in this host project. Shapes match the game
// (Assets/_NinjaSmash/Scripts/Services) as of 2026-11-18; bodies are stubs.
using System;
using UnityEngine;

namespace NinjaSmash.Services
{
    public interface IAnalyticsService
    {
        void Log(string name);
        void Log(string name, string key, object value);
        void Log(string name, string key1, object value1, string key2, object value2);
        void Log(string name, string key1, object value1, string key2, object value2, string key3, object value3);
    }

    public abstract class ServiceDefinition : ScriptableObject
    {
        public abstract void Initialize(ServiceContext context, Action<bool> done);
    }

    public class ServiceContext
    {
        public ServiceHub Hub { get; }
        public ServiceContext(ServiceHub hub, MonoBehaviour runner) { Hub = hub; }
    }

    public class ServiceHub : MonoBehaviour
    {
        public IAnalyticsService Analytics { get; private set; }
        public void SetAnalytics(IAnalyticsService service) { Analytics = service; }
    }
}
