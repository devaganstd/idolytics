using System;
using UnityEditor;
using UnityEditor.Build.Reporting;
using UnityEditor.SceneManagement;
using UnityEngine;

/// <summary>Batchmode entry points for the SDK host project.</summary>
public static class HostBuild
{
    const string ScenePath = "Assets/Sample/Sample.unity";

    [MenuItem("idolytics/Create Sample Scene")]
    public static void CreateSampleScene()
    {
        var scene = EditorSceneManager.NewScene(NewSceneSetup.DefaultGameObjects, NewSceneMode.Single);
        new GameObject("SendTestEvent").AddComponent<SendTestEvent>();
        EditorSceneManager.SaveScene(scene, ScenePath);
    }

    /// <summary>
    /// Builds the sample scene for WebGL with threads off. Output: the value after -buildPath.
    /// Unity.exe -batchmode -nographics -quit -projectPath sdk/unity-host -buildTarget WebGL
    ///   -executeMethod HostBuild.WebGL -buildPath &lt;dir&gt;
    /// </summary>
    public static void WebGL()
    {
        if (AssetDatabase.LoadAssetAtPath<SceneAsset>(ScenePath) == null) CreateSampleScene();
        PlayerSettings.WebGL.threadsSupport = false;
        var report = BuildPipeline.BuildPlayer(new BuildPlayerOptions
        {
            scenes = new[] { ScenePath },
            target = BuildTarget.WebGL,
            locationPathName = Arg("-buildPath") ?? "Builds/WebGL",
        });
        Debug.Log($"[idolytics-host] WebGL build: {report.summary.result}, {report.summary.totalErrors} errors.");
        if (report.summary.result != BuildResult.Succeeded) EditorApplication.Exit(1);
    }

    static string Arg(string name)
    {
        var args = Environment.GetCommandLineArgs();
        int i = Array.IndexOf(args, name);
        return i >= 0 && i + 1 < args.Length ? args[i + 1] : null;
    }
}
