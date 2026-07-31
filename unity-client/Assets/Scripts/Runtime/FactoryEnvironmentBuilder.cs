using System;
using System.Collections.Generic;
using System.Linq;
using HeatTreatment.DigitalTwin.Backend;
using HeatTreatment.DigitalTwin.Rendering;
using Newtonsoft.Json.Linq;
using UnityEngine;
using UnityEngine.Rendering;
using UnityEngine.Rendering.Universal;

namespace HeatTreatment.DigitalTwin.Runtime
{
    public sealed class FactoryEnvironmentBuilder : MonoBehaviour
    {
        private Transform _environmentRoot;
        private Material _groundMaterial;
        private Material _gridMaterial;
        private Material _railMaterial;
        private ReflectionProbe _reflectionProbe;

        public Camera EnsureCamera()
        {
            var camera = Camera.main;
            if (camera == null)
            {
                var cameraObject = new GameObject("FactoryCamera") { tag = "MainCamera" };
                camera = cameraObject.AddComponent<Camera>();
            }
            camera.clearFlags = CameraClearFlags.Skybox;
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
            if (FindObjectsOfType<Light>(true).All(light => light.type != LightType.Directional))
            {
                var keyObject = new GameObject("Key Sun");
                keyObject.transform.SetParent(transform, false);
                keyObject.transform.rotation = Quaternion.Euler(48f, -32f, 0f);
                var key = keyObject.AddComponent<Light>();
                key.type = LightType.Directional;
                key.color = new Color(1f, 0.93f, 0.83f);
                key.intensity = 1.15f;
                key.shadows = LightShadows.Soft;
                key.shadowStrength = 0.82f;
                key.shadowBias = 0.035f;
                key.shadowNormalBias = 0.35f;
            }

            if (FindObjectOfType<Volume>() == null)
            {
                var volumeObject = new GameObject("Professional Post Processing");
                volumeObject.transform.SetParent(transform, false);
                var volume = volumeObject.AddComponent<Volume>();
                volume.isGlobal = true;
                volume.priority = 10f;
                volume.profile = CreateVolumeProfile();
            }
        }

        public void RebuildFactoryFloor(FactoryConfigDto config, IReadOnlyList<DeviceDto> devices)
        {
            if (_environmentRoot != null) Destroy(_environmentRoot.gameObject);
            var root = new GameObject("FactoryEnvironment");
            root.transform.SetParent(transform, false);
            _environmentRoot = root.transform;

            var layoutBounds = CalculateLayoutBounds(devices);
            var width = Mathf.Max(40f, Mathf.Ceil(layoutBounds.size.x / 10f) * 10f + 18f);
            var depth = Mathf.Max(32f, Mathf.Ceil(layoutBounds.size.z / 10f) * 10f + 18f);
            var center = new Vector3(layoutBounds.center.x, -0.16f, layoutBounds.center.z);
            CreateGround(center, width, depth);
            CreateGrid(new Vector3(center.x, 0.015f, center.z), width, depth, 2f);
            CreateLineLayouts(config);
            CreateReflectionProbe(new Vector3(center.x, 4f, center.z), new Vector3(width, 12f, depth));
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
                var sky = RuntimeShaderLibrary.CreateSkyboxMaterial("Runtime Industrial Sky");
                sky.SetFloat("_SunSize", 0.03f);
                sky.SetFloat("_SunSizeConvergence", 5f);
                sky.SetFloat("_AtmosphereThickness", 0.7f);
                sky.SetColor("_SkyTint", new Color(0.24f, 0.34f, 0.44f));
                sky.SetColor("_GroundColor", new Color(0.055f, 0.065f, 0.075f));
                sky.SetFloat("_Exposure", 0.86f);
                RenderSettings.skybox = sky;
            }
            catch (Exception exception)
            {
                Debug.LogWarning($"[FactoryEnvironment] Sky material unavailable: {exception.Message}");
            }
            RenderSettings.ambientMode = AmbientMode.Skybox;
            RenderSettings.ambientIntensity = 0.82f;
            RenderSettings.reflectionIntensity = 0.92f;
            RenderSettings.defaultReflectionMode = DefaultReflectionMode.Skybox;
            RenderSettings.fog = true;
            RenderSettings.fogColor = new Color(0.09f, 0.12f, 0.15f);
            RenderSettings.fogMode = FogMode.ExponentialSquared;
            RenderSettings.fogDensity = 0.0022f;
        }

        private static VolumeProfile CreateVolumeProfile()
        {
            var profile = ScriptableObject.CreateInstance<VolumeProfile>();
            profile.name = "Runtime Professional Volume";

            var tonemapping = profile.Add<Tonemapping>();
            tonemapping.mode.Override(TonemappingMode.ACES);

            var bloom = profile.Add<Bloom>();
            bloom.threshold.Override(1.08f);
            bloom.intensity.Override(0.22f);
            bloom.scatter.Override(0.58f);

            var color = profile.Add<ColorAdjustments>();
            color.postExposure.Override(0.06f);
            color.contrast.Override(7f);
            color.saturation.Override(-3f);

            var vignette = profile.Add<Vignette>();
            vignette.intensity.Override(0.12f);
            vignette.smoothness.Override(0.62f);
            return profile;
        }

        private void CreateGround(Vector3 center, float width, float depth)
        {
            _groundMaterial = _groundMaterial ?? CreateLitMaterial(
                "Factory epoxy floor",
                new Color(0.075f, 0.09f, 0.105f),
                0.08f,
                0.43f
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
            _gridMaterial = _gridMaterial ?? CreateUnlitMaterial("Factory grid", new Color(0.16f, 0.24f, 0.29f));
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
        }

        private void CreateLineLayouts(FactoryConfigDto config)
        {
            if (config?.Workshops == null) return;
            _railMaterial = _railMaterial ?? CreateLitMaterial(
                "Rail brushed steel",
                new Color(0.19f, 0.22f, 0.24f),
                0.82f,
                0.52f
            );
            foreach (var line in config.Workshops.SelectMany(workshop => workshop.Lines ?? new List<LineDto>()))
            {
                var layout = line.LayoutObject;
                foreach (var rail in layout["rails"] as JArray ?? new JArray())
                {
                    var length = rail.Value<float?>("length") ?? 60f;
                    var z = rail.Value<float?>("offsetZ") ?? 0f;
                    CreateRailPair(line.Name, length, z);
                }
                foreach (var lane in layout["lanes"] as JArray ?? new JArray())
                {
                    var length = lane.Value<float?>("length") ?? 60f;
                    var z = lane.Value<float?>("offsetZ") ?? 0f;
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
            _reflectionProbe.intensity = 0.92f;
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
    }
}
