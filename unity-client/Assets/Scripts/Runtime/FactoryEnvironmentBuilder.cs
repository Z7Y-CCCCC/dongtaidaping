using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using HeatTreatment.DigitalTwin.Backend;
using HeatTreatment.DigitalTwin.Rendering;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using UnityEngine;
using UnityEngine.Rendering;
using UnityEngine.Rendering.Universal;

namespace HeatTreatment.DigitalTwin.Runtime
{
    public sealed class FactoryEnvironmentBuilder : MonoBehaviour
    {
        private sealed class WallSegmentConfig
        {
            [JsonProperty("id")] public string Id { get; set; } = string.Empty;
            [JsonProperty("name")] public string Name { get; set; } = "围墙";
            [JsonProperty("enabled")] public bool Enabled { get; set; } = true;
            [JsonProperty("style")] public string Style { get; set; } = "solid_frame";
            [JsonProperty("x")] public float X { get; set; }
            [JsonProperty("baseY")] public float BaseY { get; set; }
            [JsonProperty("z")] public float Z { get; set; }
            [JsonProperty("length")] public float Length { get; set; } = 30f;
            [JsonProperty("height")] public float Height { get; set; } = 6f;
            [JsonProperty("thickness")] public float Thickness { get; set; } = 0.3f;
            [JsonProperty("rotationY")] public float RotationY { get; set; }
            [JsonProperty("color")] public string Color { get; set; } = string.Empty;
            [JsonProperty("frameColor")] public string FrameColor { get; set; } = string.Empty;
        }

        private sealed class NativeEnvironmentConfig
        {
            [JsonProperty("version")] public int Version { get; set; } = 2;
            [JsonProperty("preset")] public string Preset { get; set; } = "bright_industrial";
            [JsonProperty("sceneBrightness")] public float SceneBrightness { get; set; } = 1.2f;
            [JsonProperty("ambientIntensity")] public float AmbientIntensity { get; set; } = 1.25f;
            [JsonProperty("keyLightIntensity")] public float KeyLightIntensity { get; set; } = 1.4f;
            [JsonProperty("fillLightIntensity")] public float FillLightIntensity { get; set; } = 0.82f;
            [JsonProperty("reflectionIntensity")] public float ReflectionIntensity { get; set; } = 1.08f;
            [JsonProperty("postExposure")] public float PostExposure { get; set; } = 0.6f;
            [JsonProperty("contrast")] public float Contrast { get; set; } = 2f;
            [JsonProperty("saturation")] public float Saturation { get; set; } = 3f;
            [JsonProperty("bloomIntensity")] public float BloomIntensity { get; set; } = 0.06f;
            [JsonProperty("vignetteIntensity")] public float VignetteIntensity { get; set; } = 0.035f;
            [JsonProperty("fogEnabled")] public bool FogEnabled { get; set; } = true;
            [JsonProperty("fogStart")] public float FogStart { get; set; } = 95f;
            [JsonProperty("fogEnd")] public float FogEnd { get; set; } = 360f;
            [JsonProperty("showGrid")] public bool ShowGrid { get; set; } = true;
            // Kept only so version-1 configuration can still be read. The old fixed
            // two-wall factory backdrop is intentionally no longer generated.
            [JsonProperty("showBackdrop")] public bool LegacyShowBackdrop { get; set; }
            [JsonProperty("showWalls")] public bool ShowWalls { get; set; }
            [JsonProperty("wallEditorWidth")] public float WallEditorWidth { get; set; } = 100f;
            [JsonProperty("wallEditorDepth")] public float WallEditorDepth { get; set; } = 80f;
            [JsonProperty("walls")] public List<WallSegmentConfig> Walls { get; set; } = new List<WallSegmentConfig>();
            [JsonProperty("skyColor")] public string SkyColor { get; set; } = "#607FAF";
            [JsonProperty("horizonColor")] public string HorizonColor { get; set; } = "#354A6A";
            [JsonProperty("fogColor")] public string FogColor { get; set; } = "#26364F";
            [JsonProperty("keyLightColor")] public string KeyLightColor { get; set; } = "#FFF0DC";
            [JsonProperty("fillLightColor")] public string FillLightColor { get; set; } = "#B5D2FF";
            [JsonProperty("floorColor")] public string FloorColor { get; set; } = "#263442";
            [JsonProperty("gridColor")] public string GridColor { get; set; } = "#1D4759";
            [JsonProperty("wallColor")] public string WallColor { get; set; } = "#283B59";
            [JsonProperty("frameColor")] public string FrameColor { get; set; } = "#526A86";
        }

        private Transform _environmentRoot;
        private GameObject _gridObject;
        private GameObject _wallsRoot;
        private Material _groundMaterial;
        private Material _gridMaterial;
        private Material _railMaterial;
        private Material _wallMaterial;
        private Material _frameMaterial;
        private Material _skyMaterial;
        private ReflectionProbe _reflectionProbe;
        private Light _keyLight;
        private Light _fillLight;
        private ColorAdjustments _colorAdjustments;
        private Bloom _bloom;
        private Vignette _vignette;
        private NativeEnvironmentConfig _environmentConfig = new NativeEnvironmentConfig();

        public Camera EnsureCamera()
        {
            var camera = Camera.main;
            if (camera == null)
            {
                var cameraObject = new GameObject("FactoryCamera") { tag = "MainCamera" };
                camera = cameraObject.AddComponent<Camera>();
            }
            camera.clearFlags = CameraClearFlags.Skybox;
            camera.backgroundColor = new Color(0.12f, 0.17f, 0.26f);
            camera.fieldOfView = 42f;
            camera.nearClipPlane = 0.08f;
            camera.farClipPlane = 600f;
            camera.allowHDR = true;
            camera.allowMSAA = true;
            if (camera.GetComponent<UniversalAdditionalCameraData>() == null)
            {
                camera.gameObject.AddComponent<UniversalAdditionalCameraData>();
            }
            if (camera.GetComponent<OrbitCameraController>() == null)
            {
                camera.gameObject.AddComponent<OrbitCameraController>();
            }
            return camera;
        }

        public void BuildLightingAndPostProcessing()
        {
            ConfigureSky();
            var keyObject = GameObject.Find("Key Sun");
            if (keyObject == null)
            {
                keyObject = new GameObject("Key Sun");
                keyObject.transform.SetParent(transform, false);
            }
            keyObject.transform.rotation = Quaternion.Euler(46f, -38f, 0f);
            _keyLight = keyObject.GetComponent<Light>() ?? keyObject.AddComponent<Light>();
            _keyLight.type = LightType.Directional;
            _keyLight.color = new Color(1f, 0.94f, 0.86f);
            _keyLight.shadows = LightShadows.Soft;
            _keyLight.shadowStrength = 0.7f;
            _keyLight.shadowBias = 0.035f;
            _keyLight.shadowNormalBias = 0.32f;
            RenderSettings.sun = _keyLight;

            var fillObject = GameObject.Find("Factory Fill Light");
            if (fillObject == null)
            {
                // A shadowless opposite-side fill keeps dark PBR equipment readable in
                // both overview and detail views. It is deliberately inexpensive for
                // integrated GPUs and does not create a game-like rim glow.
                fillObject = new GameObject("Factory Fill Light");
                fillObject.transform.SetParent(transform, false);
            }
            fillObject.transform.rotation = Quaternion.Euler(32f, 142f, 0f);
            _fillLight = fillObject.GetComponent<Light>() ?? fillObject.AddComponent<Light>();
            _fillLight.type = LightType.Directional;
            _fillLight.color = new Color(0.7f, 0.82f, 1f);
            _fillLight.shadows = LightShadows.None;

            var volume = FindObjectOfType<Volume>();
            if (volume == null)
            {
                var volumeObject = new GameObject("Professional Post Processing");
                volumeObject.transform.SetParent(transform, false);
                volume = volumeObject.AddComponent<Volume>();
                volume.isGlobal = true;
                volume.priority = 10f;
                volume.profile = CreateVolumeProfile();
            }
            else if (volume.profile != null)
            {
                volume.profile.TryGet(out _colorAdjustments);
                volume.profile.TryGet(out _bloom);
                volume.profile.TryGet(out _vignette);
            }
            ApplyVisualProfile();
        }

        public void ApplySettings(IReadOnlyDictionary<string, string> settings)
        {
            var next = new NativeEnvironmentConfig();
            if (settings != null
                && settings.TryGetValue("native_environment_config", out var serialized)
                && !string.IsNullOrWhiteSpace(serialized))
            {
                try
                {
                    next = JsonConvert.DeserializeObject<NativeEnvironmentConfig>(serialized)
                        ?? new NativeEnvironmentConfig();
                }
                catch (Exception exception)
                {
                    Debug.LogWarning($"[FactoryEnvironment] Invalid low-code environment configuration: {exception.Message}");
                }
            }
            // Compatibility with the short-lived single brightness setting used by an
            // earlier development build. The JSON configuration is authoritative.
            else if (settings != null
                && settings.TryGetValue("native_scene_brightness", out var legacyBrightness)
                && float.TryParse(legacyBrightness, NumberStyles.Float, CultureInfo.InvariantCulture, out var parsed))
            {
                next.SceneBrightness = parsed;
            }
            _environmentConfig = NormalizeEnvironmentConfig(next);
            RebuildCustomWalls();
            ApplyVisualProfile();
            ApplyEnvironmentVisibility();
            Debug.Log(
                $"[FactoryEnvironment] Applied low-code environment: preset={_environmentConfig.Preset}, "
                + $"brightness={_environmentConfig.SceneBrightness:0.00}, exposure={_environmentConfig.PostExposure:0.00}"
            );
        }

        public void RebuildFactoryFloor(
            FactoryConfigDto config,
            IReadOnlyList<DeviceDto> devices,
            bool createReflectionProbe = true)
        {
            if (_environmentRoot != null) Destroy(_environmentRoot.gameObject);
            var root = new GameObject("FactoryEnvironment");
            root.transform.SetParent(transform, false);
            _environmentRoot = root.transform;
            _gridObject = null;
            _wallsRoot = null;
            _reflectionProbe = null;

            var layoutBounds = CalculateLayoutBounds(devices);
            var width = Mathf.Max(54f, Mathf.Ceil(layoutBounds.size.x / 10f) * 10f + 32f);
            var depth = Mathf.Max(54f, Mathf.Ceil(layoutBounds.size.z / 10f) * 10f + 42f);
            var center = new Vector3(layoutBounds.center.x, -0.16f, layoutBounds.center.z);
            CreateGround(center, width, depth);
            CreateGrid(new Vector3(center.x, 0.015f, center.z), width, depth, 2f);
            RebuildCustomWalls();
            CreateLineLayouts(config);
            if (createReflectionProbe)
            {
                CreateReflectionProbe(new Vector3(center.x, 4f, center.z), new Vector3(width, 12f, depth));
            }
            ApplyVisualProfile();
            ApplyEnvironmentVisibility();
        }

        public void RefreshReflectionProbe()
        {
            if (_reflectionProbe == null || !isActiveAndEnabled) return;
            try { _reflectionProbe.RenderProbe(); }
            catch (Exception exception) { Debug.LogWarning($"[FactoryEnvironment] Reflection probe skipped: {exception.Message}"); }
        }

        private void ConfigureSky()
        {
            try
            {
                _skyMaterial = RuntimeShaderLibrary.CreateSkyboxMaterial("Runtime Industrial Sky");
                _skyMaterial.SetFloat("_SunSize", 0.025f);
                _skyMaterial.SetFloat("_SunSizeConvergence", 5f);
                RenderSettings.skybox = _skyMaterial;
            }
            catch (Exception exception)
            {
                Debug.LogWarning($"[FactoryEnvironment] Sky material unavailable: {exception.Message}");
            }
        }

        private VolumeProfile CreateVolumeProfile()
        {
            var profile = ScriptableObject.CreateInstance<VolumeProfile>();
            profile.name = "Runtime Professional Volume";

            var tonemapping = profile.Add<Tonemapping>();
            tonemapping.mode.Override(TonemappingMode.ACES);

            _bloom = profile.Add<Bloom>();
            _bloom.threshold.Override(1.18f);
            _bloom.intensity.Override(0.06f);
            _bloom.scatter.Override(0.42f);

            _colorAdjustments = profile.Add<ColorAdjustments>();
            _colorAdjustments.postExposure.Override(0.58f);
            _colorAdjustments.contrast.Override(2f);
            _colorAdjustments.saturation.Override(3f);

            _vignette = profile.Add<Vignette>();
            _vignette.intensity.Override(0.035f);
            _vignette.smoothness.Override(0.58f);
            return profile;
        }

        private void ApplyVisualProfile()
        {
            var config = _environmentConfig ?? new NativeEnvironmentConfig();
            var brightness = config.SceneBrightness;
            var skyColor = ParseColor(config.SkyColor, new Color(0.38f, 0.5f, 0.69f));
            var horizonColor = ParseColor(config.HorizonColor, new Color(0.21f, 0.29f, 0.42f));
            var fogColor = ParseColor(config.FogColor, new Color(0.15f, 0.21f, 0.31f));
            if (_skyMaterial != null)
            {
                _skyMaterial.SetFloat("_AtmosphereThickness", 0.95f);
                _skyMaterial.SetColor("_SkyTint", skyColor);
                _skyMaterial.SetColor("_GroundColor", horizonColor);
                _skyMaterial.SetFloat("_Exposure", 1.18f * brightness);
            }

            // Trilight ambient light makes the underside and rear faces of any imported
            // PBR model readable without adding model-specific emissive outlines.
            RenderSettings.ambientMode = AmbientMode.Trilight;
            RenderSettings.ambientSkyColor = skyColor;
            RenderSettings.ambientEquatorColor = horizonColor;
            RenderSettings.ambientGroundColor = Color.Lerp(Color.black, horizonColor, 0.58f);
            RenderSettings.ambientIntensity = config.AmbientIntensity * brightness;
            RenderSettings.reflectionIntensity = config.ReflectionIntensity;
            RenderSettings.defaultReflectionMode = DefaultReflectionMode.Skybox;
            RenderSettings.fog = config.FogEnabled;
            RenderSettings.fogColor = fogColor;
            RenderSettings.fogMode = FogMode.Linear;
            RenderSettings.fogStartDistance = config.FogStart;
            RenderSettings.fogEndDistance = config.FogEnd;

            if (_keyLight != null)
            {
                _keyLight.color = ParseColor(config.KeyLightColor, new Color(1f, 0.94f, 0.86f));
                _keyLight.intensity = config.KeyLightIntensity * brightness;
            }
            if (_fillLight != null)
            {
                _fillLight.color = ParseColor(config.FillLightColor, new Color(0.71f, 0.82f, 1f));
                _fillLight.intensity = config.FillLightIntensity * brightness;
            }
            if (_colorAdjustments != null)
            {
                _colorAdjustments.postExposure.Override(
                    config.PostExposure + Mathf.Log(Mathf.Max(0.01f, brightness), 2f) * 0.45f
                );
                _colorAdjustments.contrast.Override(config.Contrast);
                _colorAdjustments.saturation.Override(config.Saturation);
            }
            if (_bloom != null) _bloom.intensity.Override(config.BloomIntensity);
            if (_vignette != null) _vignette.intensity.Override(config.VignetteIntensity);
            if (_reflectionProbe != null) _reflectionProbe.intensity = config.ReflectionIntensity;

            var camera = Camera.main;
            if (camera != null) camera.backgroundColor = horizonColor;
            UpdateEnvironmentMaterials();
        }

        private void UpdateEnvironmentMaterials()
        {
            SetMaterialColor(_groundMaterial, GroundColor());
            SetMaterialColor(_gridMaterial, GridColor());
            SetMaterialColor(_railMaterial, RailColor());
            SetMaterialColor(_wallMaterial, WallColor());
            SetMaterialColor(_frameMaterial, FrameColor());
        }

        private Color GroundColor()
        {
            return ParseColor(_environmentConfig?.FloorColor, new Color(0.15f, 0.2f, 0.26f));
        }

        private Color GridColor()
        {
            var color = ParseColor(_environmentConfig?.GridColor, new Color(0.11f, 0.28f, 0.35f));
            return ScaleColor(color, Mathf.Lerp(0.88f, 1.12f, Mathf.InverseLerp(0.8f, 1.6f, _environmentConfig.SceneBrightness)));
        }

        private Color RailColor()
        {
            return Color.Lerp(GroundColor(), FrameColor(), 0.58f);
        }

        private Color WallColor()
        {
            return ParseColor(_environmentConfig?.WallColor, new Color(0.16f, 0.23f, 0.35f));
        }

        private Color FrameColor()
        {
            return ParseColor(_environmentConfig?.FrameColor, new Color(0.32f, 0.42f, 0.53f));
        }

        private void ApplyEnvironmentVisibility()
        {
            if (_gridObject != null) _gridObject.SetActive(_environmentConfig.ShowGrid);
            if (_wallsRoot != null) _wallsRoot.SetActive(_environmentConfig.ShowWalls);
        }

        private static NativeEnvironmentConfig NormalizeEnvironmentConfig(NativeEnvironmentConfig value)
        {
            var defaults = new NativeEnvironmentConfig();
            var config = value ?? defaults;
            config.Version = 2;
            config.Preset = string.IsNullOrWhiteSpace(config.Preset) ? "custom" : config.Preset.Trim();
            config.SceneBrightness = Mathf.Clamp(config.SceneBrightness, 0.8f, 1.6f);
            config.AmbientIntensity = Mathf.Clamp(config.AmbientIntensity, 0.2f, 2.5f);
            config.KeyLightIntensity = Mathf.Clamp(config.KeyLightIntensity, 0f, 3f);
            config.FillLightIntensity = Mathf.Clamp(config.FillLightIntensity, 0f, 2.5f);
            config.ReflectionIntensity = Mathf.Clamp(config.ReflectionIntensity, 0f, 2f);
            config.PostExposure = Mathf.Clamp(config.PostExposure, -1.5f, 2f);
            config.Contrast = Mathf.Clamp(config.Contrast, -30f, 30f);
            config.Saturation = Mathf.Clamp(config.Saturation, -30f, 30f);
            config.BloomIntensity = Mathf.Clamp(config.BloomIntensity, 0f, 1f);
            config.VignetteIntensity = Mathf.Clamp(config.VignetteIntensity, 0f, 0.5f);
            config.FogStart = Mathf.Clamp(config.FogStart, 0f, 500f);
            config.FogEnd = Mathf.Clamp(config.FogEnd, config.FogStart + 10f, 1000f);
            config.WallEditorWidth = Mathf.Clamp(config.WallEditorWidth, 20f, 1000f);
            config.WallEditorDepth = Mathf.Clamp(config.WallEditorDepth, 20f, 1000f);
            config.SkyColor = NormalizeColor(config.SkyColor, defaults.SkyColor);
            config.HorizonColor = NormalizeColor(config.HorizonColor, defaults.HorizonColor);
            config.FogColor = NormalizeColor(config.FogColor, defaults.FogColor);
            config.KeyLightColor = NormalizeColor(config.KeyLightColor, defaults.KeyLightColor);
            config.FillLightColor = NormalizeColor(config.FillLightColor, defaults.FillLightColor);
            config.FloorColor = NormalizeColor(config.FloorColor, defaults.FloorColor);
            config.GridColor = NormalizeColor(config.GridColor, defaults.GridColor);
            config.WallColor = NormalizeColor(config.WallColor, defaults.WallColor);
            config.FrameColor = NormalizeColor(config.FrameColor, defaults.FrameColor);
            config.Walls = (config.Walls ?? new List<WallSegmentConfig>())
                .Where(wall => wall != null)
                .Take(64)
                .Select((wall, index) => NormalizeWallSegment(wall, index, config))
                .ToList();
            return config;
        }

        private static WallSegmentConfig NormalizeWallSegment(
            WallSegmentConfig wall,
            int index,
            NativeEnvironmentConfig environment)
        {
            wall.Id = string.IsNullOrWhiteSpace(wall.Id) ? $"wall_{index + 1}" : wall.Id.Trim();
            wall.Name = string.IsNullOrWhiteSpace(wall.Name) ? $"围墙 {index + 1}" : wall.Name.Trim();
            wall.Style = NormalizeWallStyle(wall.Style);
            wall.X = Mathf.Clamp(wall.X, -1000f, 1000f);
            wall.BaseY = Mathf.Clamp(wall.BaseY, -10f, 50f);
            wall.Z = Mathf.Clamp(wall.Z, -1000f, 1000f);
            wall.Length = Mathf.Clamp(wall.Length, 1f, 500f);
            wall.Height = Mathf.Clamp(wall.Height, 0.5f, 100f);
            wall.Thickness = Mathf.Clamp(wall.Thickness, 0.05f, 5f);
            wall.RotationY = Mathf.Repeat(wall.RotationY + 180f, 360f) - 180f;
            wall.Color = NormalizeOptionalColor(wall.Color, environment.WallColor);
            wall.FrameColor = NormalizeOptionalColor(wall.FrameColor, environment.FrameColor);
            return wall;
        }

        private static string NormalizeWallStyle(string value)
        {
            switch ((value ?? string.Empty).Trim().ToLowerInvariant())
            {
                case "solid": return "solid";
                case "frame": return "frame";
                default: return "solid_frame";
            }
        }

        private static string NormalizeOptionalColor(string value, string fallback)
        {
            if (string.IsNullOrWhiteSpace(value)) return string.Empty;
            return NormalizeColor(value, fallback);
        }

        private static string NormalizeColor(string value, string fallback)
        {
            return ColorUtility.TryParseHtmlString(value ?? string.Empty, out _) ? value : fallback;
        }

        private static Color ParseColor(string value, Color fallback)
        {
            return ColorUtility.TryParseHtmlString(value ?? string.Empty, out var parsed) ? parsed : fallback;
        }

        private static Color ScaleColor(Color color, float multiplier)
        {
            return new Color(
                Mathf.Clamp01(color.r * multiplier),
                Mathf.Clamp01(color.g * multiplier),
                Mathf.Clamp01(color.b * multiplier),
                color.a
            );
        }

        private void CreateGround(Vector3 center, float width, float depth)
        {
            _groundMaterial = _groundMaterial ?? CreateLitMaterial(
                "Factory epoxy floor",
                GroundColor(),
                0.12f,
                0.48f
            );
            var ground = GameObject.CreatePrimitive(PrimitiveType.Cube);
            ground.name = "Factory Floor";
            ground.transform.SetParent(_environmentRoot, false);
            ground.transform.position = center;
            ground.transform.localScale = new Vector3(width, 0.3f, depth);
            ground.GetComponent<Renderer>().sharedMaterial = _groundMaterial;
            var collider = ground.GetComponent<Collider>();
            if (collider != null) Destroy(collider);
        }

        private void CreateGrid(Vector3 center, float width, float depth, float spacing)
        {
            _gridMaterial = _gridMaterial ?? CreateUnlitMaterial("Factory grid", GridColor());
            var vertices = new List<Vector3>();
            var indices = new List<int>();
            var halfWidth = width * 0.5f;
            var halfDepth = depth * 0.5f;
            for (var x = -halfWidth; x <= halfWidth + 0.01f; x += spacing)
            {
                indices.Add(vertices.Count);
                vertices.Add(center + new Vector3(x, 0f, -halfDepth));
                indices.Add(vertices.Count);
                vertices.Add(center + new Vector3(x, 0f, halfDepth));
            }
            for (var z = -halfDepth; z <= halfDepth + 0.01f; z += spacing)
            {
                indices.Add(vertices.Count);
                vertices.Add(center + new Vector3(-halfWidth, 0f, z));
                indices.Add(vertices.Count);
                vertices.Add(center + new Vector3(halfWidth, 0f, z));
            }

            var mesh = new Mesh { name = "Factory grid mesh" };
            mesh.SetVertices(vertices);
            mesh.SetIndices(indices, MeshTopology.Lines, 0);
            mesh.RecalculateBounds();
            var grid = new GameObject("Factory Grid");
            grid.transform.SetParent(_environmentRoot, false);
            grid.AddComponent<MeshFilter>().sharedMesh = mesh;
            grid.AddComponent<MeshRenderer>().sharedMaterial = _gridMaterial;
            _gridObject = grid;
        }

        private void RebuildCustomWalls()
        {
            if (_environmentRoot == null) return;
            if (_wallsRoot != null) Destroy(_wallsRoot);

            _wallsRoot = new GameObject("Factory Custom Walls");
            _wallsRoot.transform.SetParent(_environmentRoot, false);
            _wallMaterial = _wallMaterial ?? CreateLitMaterial(
                "Factory wall default",
                WallColor(),
                0.16f,
                0.34f
            );
            _frameMaterial = _frameMaterial ?? CreateLitMaterial(
                "Factory wall frame default",
                FrameColor(),
                0.72f,
                0.46f
            );

            foreach (var wall in _environmentConfig.Walls.Where(item => item.Enabled))
            {
                CreateCustomWall(wall);
            }
            _wallsRoot.SetActive(_environmentConfig.ShowWalls);
        }

        private void CreateCustomWall(WallSegmentConfig wall)
        {
            var wallRoot = new GameObject($"Custom Wall - {wall.Name}");
            wallRoot.transform.SetParent(_wallsRoot.transform, false);
            wallRoot.transform.localPosition = new Vector3(wall.X, wall.BaseY, wall.Z);
            wallRoot.transform.localRotation = Quaternion.Euler(0f, wall.RotationY, 0f);

            var solidEnabled = wall.Style == "solid" || wall.Style == "solid_frame";
            var frameEnabled = wall.Style == "frame" || wall.Style == "solid_frame";
            var wallMaterial = string.IsNullOrWhiteSpace(wall.Color)
                ? _wallMaterial
                : CreateLitMaterial($"{wall.Name} wall material", ParseColor(wall.Color, WallColor()), 0.16f, 0.34f);
            var frameMaterial = string.IsNullOrWhiteSpace(wall.FrameColor)
                ? _frameMaterial
                : CreateLitMaterial($"{wall.Name} frame material", ParseColor(wall.FrameColor, FrameColor()), 0.72f, 0.46f);

            if (solidEnabled)
            {
                CreateWallBlock(
                    wallRoot.transform,
                    $"{wall.Name} Solid",
                    new Vector3(0f, wall.Height * 0.5f, 0f),
                    new Vector3(wall.Length, wall.Height, wall.Thickness),
                    wallMaterial,
                    false
                );
            }

            if (!frameEnabled) return;
            var frameWidth = Mathf.Clamp(wall.Thickness * 0.78f, 0.16f, 0.42f);
            var frameDepth = Mathf.Clamp(wall.Thickness * 0.7f, 0.14f, 0.46f);
            var frameZ = -(wall.Thickness * 0.5f + frameDepth * 0.5f + 0.025f);
            var columnCount = Mathf.Clamp(Mathf.CeilToInt(wall.Length / 6f), 1, 80);
            for (var index = 0; index <= columnCount; index += 1)
            {
                var x = Mathf.Lerp(-wall.Length * 0.5f, wall.Length * 0.5f, index / (float)columnCount);
                CreateWallBlock(
                    wallRoot.transform,
                    $"{wall.Name} Column {index + 1}",
                    new Vector3(x, wall.Height * 0.5f, frameZ),
                    new Vector3(frameWidth, wall.Height, frameDepth),
                    frameMaterial,
                    true
                );
            }

            var beamCount = Mathf.Clamp(Mathf.CeilToInt(wall.Height / 2.8f) + 1, 2, 16);
            for (var index = 0; index < beamCount; index += 1)
            {
                var y = Mathf.Lerp(0.25f, Mathf.Max(0.25f, wall.Height - 0.25f), index / (float)(beamCount - 1));
                CreateWallBlock(
                    wallRoot.transform,
                    $"{wall.Name} Beam {index + 1}",
                    new Vector3(0f, y, frameZ),
                    new Vector3(wall.Length, Mathf.Min(0.24f, wall.Height * 0.12f), frameDepth),
                    frameMaterial,
                    true
                );
            }
        }

        private void CreateWallBlock(
            Transform parent,
            string name,
            Vector3 localPosition,
            Vector3 localScale,
            Material material,
            bool castShadows)
        {
            var block = GameObject.CreatePrimitive(PrimitiveType.Cube);
            block.name = name;
            block.transform.SetParent(parent, false);
            block.transform.localPosition = localPosition;
            block.transform.localScale = localScale;
            var renderer = block.GetComponent<Renderer>();
            renderer.sharedMaterial = material;
            renderer.shadowCastingMode = castShadows ? ShadowCastingMode.On : ShadowCastingMode.Off;
            renderer.receiveShadows = true;
            var collider = block.GetComponent<Collider>();
            if (collider != null) Destroy(collider);
        }

        private void CreateLineLayouts(FactoryConfigDto config)
        {
            if (config?.Workshops == null) return;
            _railMaterial = _railMaterial ?? CreateLitMaterial(
                "Rail brushed steel",
                RailColor(),
                0.82f,
                0.52f
            );
            var lines = config.Workshops
                .SelectMany(workshop => workshop.Lines ?? new List<LineDto>())
                .ToList();
            for (var lineIndex = 0; lineIndex < lines.Count; lineIndex += 1)
            {
                var line = lines[lineIndex];
                // Keep the native floor guides on the exact same world-coordinate convention
                // as the admin composer/Web compatibility layer: each global line is spaced
                // 16 metres along negative Z, while the lane/rail value is a relative offset.
                var lineBaseZ = -lineIndex * 16f;
                var layout = line.LayoutObject;
                foreach (var rail in layout["rails"] as JArray ?? new JArray())
                {
                    var length = rail.Value<float?>("length") ?? 60f;
                    var z = lineBaseZ + (rail.Value<float?>("offsetZ") ?? 0f);
                    CreateRailPair(line.Name, length, z);
                }
                foreach (var lane in layout["lanes"] as JArray ?? new JArray())
                {
                    var length = lane.Value<float?>("length") ?? 60f;
                    var z = lineBaseZ + (lane.Value<float?>("offsetZ") ?? 0f);
                    CreateLaneMarker(line.Name, length, z);
                }
            }
        }

        private void CreateRailPair(string lineName, float length, float z)
        {
            for (var side = -1; side <= 1; side += 2)
            {
                var rail = GameObject.CreatePrimitive(PrimitiveType.Cube);
                rail.name = $"{lineName} Rail";
                rail.transform.SetParent(_environmentRoot, false);
                rail.transform.localPosition = new Vector3(0f, 0.08f, z + side * 0.68f);
                rail.transform.localScale = new Vector3(length, 0.12f, 0.11f);
                rail.GetComponent<Renderer>().sharedMaterial = _railMaterial;
                var collider = rail.GetComponent<Collider>();
                if (collider != null) Destroy(collider);
            }
        }

        private void CreateLaneMarker(string lineName, float length, float z)
        {
            var markerMaterial = CreateUnlitMaterial("Lane marker", new Color(0.15f, 0.42f, 0.55f));
            for (var side = -1; side <= 1; side += 2)
            {
                var marker = GameObject.CreatePrimitive(PrimitiveType.Cube);
                marker.name = $"{lineName} Lane Marker";
                marker.transform.SetParent(_environmentRoot, false);
                marker.transform.localPosition = new Vector3(0f, 0.02f, z + side * 2.7f);
                marker.transform.localScale = new Vector3(length, 0.018f, 0.045f);
                marker.GetComponent<Renderer>().sharedMaterial = markerMaterial;
                var collider = marker.GetComponent<Collider>();
                if (collider != null) Destroy(collider);
            }
        }

        private void CreateReflectionProbe(Vector3 center, Vector3 size)
        {
            var probeObject = new GameObject("Factory Reflection Probe");
            probeObject.transform.SetParent(_environmentRoot, false);
            probeObject.transform.position = center;
            _reflectionProbe = probeObject.AddComponent<ReflectionProbe>();
            _reflectionProbe.mode = ReflectionProbeMode.Realtime;
            _reflectionProbe.refreshMode = ReflectionProbeRefreshMode.ViaScripting;
            _reflectionProbe.timeSlicingMode = ReflectionProbeTimeSlicingMode.AllFacesAtOnce;
            _reflectionProbe.resolution = 256;
            _reflectionProbe.hdr = true;
            _reflectionProbe.boxProjection = true;
            _reflectionProbe.size = size;
            _reflectionProbe.intensity = _environmentConfig.ReflectionIntensity;
            _reflectionProbe.cullingMask = ~0;
        }

        private static Bounds CalculateLayoutBounds(IReadOnlyList<DeviceDto> devices)
        {
            if (devices == null || devices.Count == 0) return new Bounds(Vector3.zero, new Vector3(40f, 8f, 30f));
            var bounds = new Bounds(new Vector3(devices[0].PositionX, 0f, devices[0].PositionZ), Vector3.zero);
            foreach (var device in devices)
            {
                bounds.Encapsulate(new Vector3(device.PositionX, 0f, device.PositionZ));
            }
            bounds.Expand(new Vector3(14f, 8f, 14f));
            return bounds;
        }

        private static Material CreateLitMaterial(string name, Color color, float metallic, float smoothness)
        {
            var material = RuntimeShaderLibrary.CreateLitMaterial(name);
            material.color = color;
            if (material.HasProperty("_BaseColor")) material.SetColor("_BaseColor", color);
            if (material.HasProperty("_Metallic")) material.SetFloat("_Metallic", metallic);
            if (material.HasProperty("_Smoothness")) material.SetFloat("_Smoothness", smoothness);
            return material;
        }

        private static Material CreateUnlitMaterial(string name, Color color)
        {
            var material = RuntimeShaderLibrary.CreateUnlitMaterial(name);
            material.color = color;
            if (material.HasProperty("_BaseColor")) material.SetColor("_BaseColor", color);
            return material;
        }

        private static void SetMaterialColor(Material material, Color color)
        {
            if (material == null) return;
            material.color = color;
            if (material.HasProperty("_BaseColor")) material.SetColor("_BaseColor", color);
        }
    }
}
