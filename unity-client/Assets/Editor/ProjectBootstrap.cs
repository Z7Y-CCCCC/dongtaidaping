#if UNITY_EDITOR
using System.IO;
using System.Reflection;
using HeatTreatment.DigitalTwin.Runtime;
using UnityEditor;
using UnityEditor.Build;
using UnityEditor.Build.Reporting;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.Rendering;
using UnityEngine.Rendering.Universal;
using UnityEngine.SceneManagement;

namespace HeatTreatment.DigitalTwin.Editor
{
    [InitializeOnLoad]
    public static class ProjectBootstrap
    {
        private const string SettingsDirectory = "Assets/Settings";
        private const string ScenesDirectory = "Assets/Scenes";
        private const string ResourcesDirectory = "Assets/Resources";
        private const string RuntimeMaterialsDirectory = ResourcesDirectory + "/RuntimeMaterials";
        private const string RendererPath = SettingsDirectory + "/DigitalTwinRenderer.asset";
        private const string PipelinePath = SettingsDirectory + "/DigitalTwinPipeline.asset";
        private const string ScenePath = ScenesDirectory + "/Factory.unity";
        private const string ApplicationIconPath = "Assets/Branding/AppIcon.png";

        static ProjectBootstrap()
        {
            EditorApplication.delayCall += AutoBootstrap;
        }

        [MenuItem("Digital Twin/Bootstrap Project", priority = 1)]
        public static void BootstrapProject()
        {
            EnsureDirectories();
            ConfigurePipeline();
            ConfigureRuntimeMaterials();
            EnsureFactoryScene();
            ConfigurePlayer();
            ConfigureBuildScenes();
            AssetDatabase.SaveAssets();
            Debug.Log("[Digital Twin] Unity project bootstrap complete.");
        }

        [MenuItem("Digital Twin/Open Factory Scene", priority = 2)]
        public static void OpenFactoryScene()
        {
            if (!File.Exists(ScenePath)) BootstrapProject();
            EditorSceneManager.OpenScene(ScenePath, OpenSceneMode.Single);
        }

        [MenuItem("Digital Twin/Build Windows Client", priority = 20)]
        public static void BuildWindowsClient()
        {
            BootstrapProject();
            EditorUserBuildSettings.SwitchActiveBuildTarget(BuildTargetGroup.Standalone, BuildTarget.StandaloneWindows64);
            var buildDirectory = Path.GetFullPath("Builds/Windows");
            Directory.CreateDirectory(buildDirectory);
            var options = new BuildPlayerOptions
            {
                scenes = new[] { ScenePath },
                locationPathName = Path.Combine(buildDirectory, "HeatTreatmentDigitalTwin.exe"),
                target = BuildTarget.StandaloneWindows64,
                targetGroup = BuildTargetGroup.Standalone,
                options = BuildOptions.None
            };
            var report = BuildPipeline.BuildPlayer(options);
            if (report.summary.result != BuildResult.Succeeded)
            {
                throw new BuildFailedException($"Windows build failed: {report.summary.result}");
            }
            Debug.Log($"[Digital Twin] Windows build created: {options.locationPathName}");
            if (!Application.isBatchMode) EditorUtility.RevealInFinder(buildDirectory);
        }

        private static void AutoBootstrap()
        {
            if (EditorApplication.isPlayingOrWillChangePlaymode || EditorApplication.isCompiling) return;
            if (File.Exists(ScenePath) && AssetDatabase.LoadAssetAtPath<UniversalRenderPipelineAsset>(PipelinePath) != null) return;
            BootstrapProject();
        }

        private static void EnsureDirectories()
        {
            if (!AssetDatabase.IsValidFolder(SettingsDirectory)) AssetDatabase.CreateFolder("Assets", "Settings");
            if (!AssetDatabase.IsValidFolder(ScenesDirectory)) AssetDatabase.CreateFolder("Assets", "Scenes");
            if (!AssetDatabase.IsValidFolder(ResourcesDirectory)) AssetDatabase.CreateFolder("Assets", "Resources");
            if (!AssetDatabase.IsValidFolder(RuntimeMaterialsDirectory))
            {
                AssetDatabase.CreateFolder(ResourcesDirectory, "RuntimeMaterials");
            }
        }

        private static void ConfigureRuntimeMaterials()
        {
            CreateOrUpdateMaterial(
                RuntimeMaterialsDirectory + "/FactoryLit.mat",
                "Universal Render Pipeline/Lit"
            );
            CreateOrUpdateMaterial(
                RuntimeMaterialsDirectory + "/FactoryUnlit.mat",
                "Universal Render Pipeline/Unlit"
            );
            CreateOrUpdateMaterial(
                RuntimeMaterialsDirectory + "/FactorySky.mat",
                "Skybox/Procedural"
            );
            CreateOrUpdatePackageMaterial(
                RuntimeMaterialsDirectory + "/GltfMetallicRoughness.mat",
                "Packages/com.atteneder.gltfast/Runtime/Shader/glTF-pbrMetallicRoughness.shadergraph"
            );
            CreateOrUpdatePackageMaterial(
                RuntimeMaterialsDirectory + "/GltfUnlit.mat",
                "Packages/com.atteneder.gltfast/Runtime/Shader/glTF-unlit.shadergraph"
            );
            CreateOrUpdatePackageMaterial(
                RuntimeMaterialsDirectory + "/GltfSpecularGlossiness.mat",
                "Packages/com.atteneder.gltfast/Runtime/Shader/glTF-pbrSpecularGlossiness.shadergraph"
            );
        }

        private static void CreateOrUpdateMaterial(string assetPath, string shaderName)
        {
            var shader = Shader.Find(shaderName);
            if (shader == null) throw new BuildFailedException($"Required shader not found: {shaderName}");
            var material = AssetDatabase.LoadAssetAtPath<Material>(assetPath);
            if (material == null)
            {
                material = new Material(shader) { name = Path.GetFileNameWithoutExtension(assetPath) };
                AssetDatabase.CreateAsset(material, assetPath);
            }
            else if (material.shader != shader)
            {
                material.shader = shader;
            }
            material.enableInstancing = true;
            EditorUtility.SetDirty(material);
        }

        private static void CreateOrUpdatePackageMaterial(string assetPath, string shaderAssetPath)
        {
            var shader = AssetDatabase.LoadAssetAtPath<Shader>(shaderAssetPath);
            if (shader == null) throw new BuildFailedException($"Required shader asset not found: {shaderAssetPath}");
            var material = AssetDatabase.LoadAssetAtPath<Material>(assetPath);
            if (material == null)
            {
                material = new Material(shader) { name = Path.GetFileNameWithoutExtension(assetPath) };
                AssetDatabase.CreateAsset(material, assetPath);
            }
            else if (material.shader != shader)
            {
                material.shader = shader;
            }
            material.enableInstancing = true;
            EditorUtility.SetDirty(material);
        }

        private static void ConfigurePipeline()
        {
            var renderer = AssetDatabase.LoadAssetAtPath<UniversalRendererData>(RendererPath);
            if (renderer == null || renderer.postProcessData == null)
            {
                if (renderer != null) AssetDatabase.DeleteAsset(RendererPath);
                renderer = CreateRendererAsset();
            }

            var pipeline = AssetDatabase.LoadAssetAtPath<UniversalRenderPipelineAsset>(PipelinePath);
            if (pipeline == null)
            {
                pipeline = UniversalRenderPipelineAsset.Create(renderer);
                pipeline.name = "Digital Twin Pipeline";
                AssetDatabase.CreateAsset(pipeline, PipelinePath);
            }
            else
            {
                var serializedPipeline = new SerializedObject(pipeline);
                var rendererList = serializedPipeline.FindProperty("m_RendererDataList");
                if (rendererList != null && rendererList.arraySize > 0)
                {
                    rendererList.GetArrayElementAtIndex(0).objectReferenceValue = renderer;
                    serializedPipeline.ApplyModifiedPropertiesWithoutUndo();
                }
            }
            pipeline.renderScale = 1f;
            pipeline.msaaSampleCount = 4;
            pipeline.supportsHDR = true;
            pipeline.supportsCameraDepthTexture = true;
            pipeline.supportsCameraOpaqueTexture = false;
            pipeline.shadowDistance = 80f;
            pipeline.shadowCascadeCount = 2;

            var serializedSettings = new SerializedObject(pipeline);
            SetEnum(serializedSettings, "m_MainLightRenderingMode", (int)LightRenderingMode.PerPixel);
            SetEnum(serializedSettings, "m_AdditionalLightsRenderingMode", (int)LightRenderingMode.PerPixel);
            SetBool(serializedSettings, "m_MainLightShadowsSupported", true);
            SetBool(serializedSettings, "m_AdditionalLightShadowsSupported", true);
            SetBool(serializedSettings, "m_SoftShadowsSupported", true);
            SetEnum(serializedSettings, "m_MainLightShadowmapResolution", 2048);
            SetEnum(serializedSettings, "m_AdditionalLightsShadowmapResolution", 1024);
            serializedSettings.ApplyModifiedPropertiesWithoutUndo();
            EditorUtility.SetDirty(pipeline);

            GraphicsSettings.defaultRenderPipeline = pipeline;
            QualitySettings.renderPipeline = pipeline;
        }

        private static UniversalRendererData CreateRendererAsset()
        {
            var method = typeof(UniversalRenderPipelineAsset).GetMethod(
                "CreateRendererAsset",
                BindingFlags.Static | BindingFlags.NonPublic
            );
            if (method != null)
            {
                var created = method.Invoke(null, new object[]
                {
                    RendererPath,
                    RendererType.UniversalRenderer,
                    false,
                    "Renderer"
                }) as UniversalRendererData;
                if (created != null)
                {
                    created.name = "Digital Twin Renderer";
                    EditorUtility.SetDirty(created);
                    return created;
                }
            }

            var fallback = ScriptableObject.CreateInstance<UniversalRendererData>();
            fallback.name = "Digital Twin Renderer";
            AssetDatabase.CreateAsset(fallback, RendererPath);
            return fallback;
        }

        private static void EnsureFactoryScene()
        {
            if (File.Exists(ScenePath)) return;
            var previousActive = SceneManager.GetActiveScene();
            var replaceUntitledScene = previousActive.IsValid() && string.IsNullOrEmpty(previousActive.path);
            var scene = EditorSceneManager.NewScene(
                NewSceneSetup.EmptyScene,
                replaceUntitledScene ? NewSceneMode.Single : NewSceneMode.Additive
            );
            SceneManager.SetActiveScene(scene);
            var runtime = new GameObject("DigitalTwinRuntime");
            runtime.AddComponent<FactoryRuntime>();
            EditorSceneManager.SaveScene(scene, ScenePath);
            if (!replaceUntitledScene)
            {
                if (previousActive.IsValid()) SceneManager.SetActiveScene(previousActive);
                EditorSceneManager.CloseScene(scene, true);
            }
        }

        private static void ConfigurePlayer()
        {
            PlayerSettings.companyName = "Heat Treatment Digital Twin";
            PlayerSettings.productName = "Heat Treatment Digital Twin";
            PlayerSettings.colorSpace = ColorSpace.Linear;
            PlayerSettings.fullScreenMode = FullScreenMode.FullScreenWindow;
            PlayerSettings.defaultScreenWidth = 1920;
            PlayerSettings.defaultScreenHeight = 1080;
            PlayerSettings.defaultIsNativeResolution = true;
            PlayerSettings.resizableWindow = true;
            PlayerSettings.runInBackground = true;
            PlayerSettings.usePlayerLog = true;
            var applicationIcon = AssetDatabase.LoadAssetAtPath<Texture2D>(ApplicationIconPath);
            if (applicationIcon != null)
            {
                var iconSizes = PlayerSettings.GetIconSizesForTargetGroup(BuildTargetGroup.Standalone);
                var applicationIcons = new Texture2D[iconSizes.Length];
                for (var index = 0; index < applicationIcons.Length; index++)
                {
                    applicationIcons[index] = applicationIcon;
                }
                PlayerSettings.SetIconsForTargetGroup(BuildTargetGroup.Standalone, applicationIcons);
            }
            else
            {
                Debug.LogWarning($"[Digital Twin] Application icon not found: {ApplicationIconPath}");
            }
            PlayerSettings.SetScriptingBackend(BuildTargetGroup.Standalone, ScriptingImplementation.Mono2x);
            PlayerSettings.SetGraphicsAPIs(BuildTarget.StandaloneWindows64, new[] { GraphicsDeviceType.Direct3D11 });
        }

        private static void ConfigureBuildScenes()
        {
            EditorBuildSettings.scenes = new[] { new EditorBuildSettingsScene(ScenePath, true) };
        }

        private static void SetBool(SerializedObject serializedObject, string propertyName, bool value)
        {
            var property = serializedObject.FindProperty(propertyName);
            if (property != null) property.boolValue = value;
        }

        private static void SetEnum(SerializedObject serializedObject, string propertyName, int value)
        {
            var property = serializedObject.FindProperty(propertyName);
            if (property != null) property.intValue = value;
        }
    }
}
#endif
