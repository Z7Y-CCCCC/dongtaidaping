using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using GLTFast;
using HeatTreatment.DigitalTwin.Backend;
using Newtonsoft.Json.Linq;
using UnityEngine;

namespace HeatTreatment.DigitalTwin.Rendering
{
    public sealed class RuntimeModelInstance
    {
        public GameObject Root { get; internal set; }
        public ModelAssetDto Asset { get; internal set; }
        public IReadOnlyList<PartBindingDto> Bindings { get; internal set; }
        public RuntimeModelOptimizationReport OptimizationReport { get; internal set; }
        public bool IsFallback { get; internal set; }
    }

    /// <summary>
    /// Loads each glTF asset once, optimizes a hidden template, and then clones it for all devices.
    /// Unity clones keep shared Mesh/Material references, so repeated equipment does not duplicate GPU data.
    /// </summary>
    public sealed class RuntimeModelLibrary : MonoBehaviour
    {
        private sealed class TemplateEntry
        {
            public ModelAssetDto Asset;
            public GameObject Root;
            public List<PartBindingDto> Bindings;
            public RuntimeModelOptimizationReport OptimizationReport;
            public GltfImport Importer;
            public bool IsFallback;
        }

        private readonly Dictionary<string, ModelAssetDto> _assets = new Dictionary<string, ModelAssetDto>();
        private readonly Dictionary<string, TemplateEntry> _templates = new Dictionary<string, TemplateEntry>();
        private string _backendBaseUrl;
        private float _loadTimeoutSeconds = 30f;
        private Transform _templateContainer;

        public int LoadedTemplateCount => _templates.Count;

        public void Configure(string backendBaseUrl, IEnumerable<ModelAssetDto> assets, float loadTimeoutSeconds)
        {
            _backendBaseUrl = (backendBaseUrl ?? string.Empty).TrimEnd('/');
            _loadTimeoutSeconds = Mathf.Max(5f, loadTimeoutSeconds);
            _assets.Clear();
            foreach (var asset in assets ?? Enumerable.Empty<ModelAssetDto>())
            {
                if (asset == null || string.IsNullOrWhiteSpace(asset.Id)) continue;
                _assets[asset.Id] = asset;
            }

            if (_templateContainer == null)
            {
                var container = new GameObject("__RuntimeModelTemplates");
                container.transform.SetParent(transform, false);
                container.SetActive(false);
                _templateContainer = container.transform;
            }
        }

        public async Task<RuntimeModelInstance> InstantiateAsync(
            DeviceDto device,
            Transform parent,
            CancellationToken cancellationToken)
        {
            if (device == null) throw new ArgumentNullException(nameof(device));
            var asset = ResolveAsset(device.ModelType);
            var key = CacheKey(asset, device.ModelType);
            if (!_templates.TryGetValue(key, out var template))
            {
                template = await LoadTemplateSafeAsync(asset, device.ModelType, cancellationToken);
                _templates[key] = template;
            }

            var clone = Instantiate(template.Root, parent, false);
            clone.name = string.IsNullOrWhiteSpace(device.Name) ? device.Id : device.Name;
            ApplyDeviceTransform(clone.transform, device, template.Asset);
            clone.SetActive(true);

            var driver = clone.AddComponent<ModelBindingDriver>();
            driver.Configure(template.Bindings);
            return new RuntimeModelInstance
            {
                Root = clone,
                Asset = template.Asset,
                Bindings = template.Bindings,
                OptimizationReport = template.OptimizationReport,
                IsFallback = template.IsFallback
            };
        }

        private async Task<TemplateEntry> LoadTemplateSafeAsync(
            ModelAssetDto asset,
            string requestedModelType,
            CancellationToken cancellationToken)
        {
            if (asset == null || string.IsNullOrWhiteSpace(asset.FilePath))
            {
                return CreateFallbackTemplate(asset, requestedModelType, null);
            }

            try
            {
                return await LoadGltfTemplateAsync(asset, cancellationToken);
            }
            catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
            {
                var message = $"Model load timed out after {_loadTimeoutSeconds:0}s: {asset.Id}";
                Debug.LogError($"[RuntimeModelLibrary] {message}");
                return CreateFallbackTemplate(asset, requestedModelType, message);
            }
            catch (Exception exception)
            {
                Debug.LogError($"[RuntimeModelLibrary] Failed to load {asset.Id}: {exception}");
                return CreateFallbackTemplate(asset, requestedModelType, exception.Message);
            }
        }

        private async Task<TemplateEntry> LoadGltfTemplateAsync(ModelAssetDto asset, CancellationToken cancellationToken)
        {
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            timeout.CancelAfter(TimeSpan.FromSeconds(_loadTimeoutSeconds));

            var root = new GameObject($"template_{asset.Id}");
            root.transform.SetParent(_templateContainer, false);
            var importer = new GltfImport(new LoopbackDownloadProvider());
            var settings = new ImportSettings
            {
                GenerateMipMaps = true,
                AnisotropicFilterLevel = 4,
                NodeNameMethod = NameImportMethod.Original
            };

            var url = ResolveAssetUrl(asset.FilePath);
            var loaded = await importer.Load(url, settings, timeout.Token);
            if (!loaded)
            {
                importer.Dispose();
                Destroy(root);
                throw new InvalidOperationException($"glTFast rejected model '{asset.Id}' from {url}");
            }

            var instantiated = await importer.InstantiateMainSceneAsync(root.transform, timeout.Token);
            if (!instantiated)
            {
                importer.Dispose();
                Destroy(root);
                throw new InvalidOperationException($"glTFast could not instantiate model '{asset.Id}'");
            }

            var bindings = ReadBindings(asset.MetadataObject);
            var options = ModelOptimizationOptions.FromMetadata(asset.MetadataObject);
            var report = RuntimeModelOptimizer.Optimize(
                root,
                bindings.Select(binding => binding.NodeName),
                options
            );
            root.SetActive(false);
            Debug.Log($"[RuntimeModelLibrary] Loaded {asset.Id}: {report}");
            return new TemplateEntry
            {
                Asset = asset,
                Root = root,
                Bindings = bindings,
                OptimizationReport = report,
                Importer = importer,
                IsFallback = false
            };
        }

        private TemplateEntry CreateFallbackTemplate(ModelAssetDto asset, string requestedModelType, string reason)
        {
            var effectiveAsset = asset ?? new ModelAssetDto
            {
                Id = requestedModelType ?? "missing_model",
                Name = requestedModelType ?? "Missing model",
                DefaultScale = 1f
            };
            var root = new GameObject($"template_{effectiveAsset.Id}_fallback");
            root.transform.SetParent(_templateContainer, false);
            if (string.Equals(requestedModelType, "transfer_cart", StringComparison.OrdinalIgnoreCase))
            {
                BuildTransferCartFallback(root.transform);
            }
            else
            {
                BuildEquipmentFallback(root.transform);
            }
            root.SetActive(false);
            if (!string.IsNullOrWhiteSpace(reason))
            {
                Debug.LogWarning($"[RuntimeModelLibrary] Using fallback for {effectiveAsset.Id}: {reason}");
            }
            return new TemplateEntry
            {
                Asset = effectiveAsset,
                Root = root,
                Bindings = ReadBindings(effectiveAsset.MetadataObject),
                OptimizationReport = new RuntimeModelOptimizationReport(),
                IsFallback = true
            };
        }

        private ModelAssetDto ResolveAsset(string modelType)
        {
            if (!string.IsNullOrWhiteSpace(modelType) && _assets.TryGetValue(modelType, out var asset)) return asset;
            return null;
        }

        private string ResolveAssetUrl(string filePath)
        {
            if (string.IsNullOrWhiteSpace(filePath)) return string.Empty;
            if (Uri.TryCreate(filePath, UriKind.Absolute, out var absolute)
                && (absolute.Scheme == Uri.UriSchemeHttp || absolute.Scheme == Uri.UriSchemeHttps))
            {
                return absolute.AbsoluteUri;
            }
            var isWindowsPath = filePath.Length > 2 && char.IsLetter(filePath[0]) && filePath[1] == ':';
            if (isWindowsPath || filePath.StartsWith(@"\\", StringComparison.Ordinal))
            {
                return new Uri(Path.GetFullPath(filePath)).AbsoluteUri;
            }
            if (filePath.StartsWith("file:", StringComparison.OrdinalIgnoreCase)) return new Uri(filePath).AbsoluteUri;
            var origin = new Uri($"{_backendBaseUrl.TrimEnd('/')}/", UriKind.Absolute);
            return new Uri(origin, filePath.TrimStart('/')).AbsoluteUri;
        }

        private static string CacheKey(ModelAssetDto asset, string modelType)
        {
            return asset == null
                ? $"fallback:{modelType}"
                : $"{asset.Id}:{asset.FilePath}";
        }

        private static List<PartBindingDto> ReadBindings(JObject metadata)
        {
            try
            {
                return metadata?["partBindings"]?.ToObject<List<PartBindingDto>>()
                    ?? new List<PartBindingDto>();
            }
            catch (Exception exception)
            {
                Debug.LogWarning($"[RuntimeModelLibrary] Invalid part bindings: {exception.Message}");
                return new List<PartBindingDto>();
            }
        }

        private static void ApplyDeviceTransform(Transform target, DeviceDto device, ModelAssetDto asset)
        {
            var config = device.InstanceConfigObject;
            var scaleMultiplier = config.Value<float?>("scaleMultiplier") ?? 1f;
            var scale = Mathf.Max(0.0001f, device.Scale * (asset?.DefaultScale ?? 1f) * scaleMultiplier);
            var mirrorX = config.Value<bool?>("mirrorX")
                ?? config.Value<bool?>("mirror_x")
                ?? (string.Equals(config.Value<string>("mirrorAxis"), "x", StringComparison.OrdinalIgnoreCase)
                    || string.Equals(config.Value<string>("mirror_axis"), "x", StringComparison.OrdinalIgnoreCase));
            target.localPosition = new Vector3(device.PositionX, device.PositionY, device.PositionZ);
            var rotationDegrees = Mathf.Abs(device.RotationY) <= Mathf.PI * 2f + 0.01f
                ? device.RotationY * Mathf.Rad2Deg
                : device.RotationY;
            // The Web scene and glTF use a right-handed coordinate system while Unity uses
            // a left-handed world. Positions are shared directly, but yaw must be inverted
            // so an existing Web layout keeps the same equipment-facing direction.
            target.localRotation = Quaternion.Euler(0f, -rotationDegrees, 0f);
            target.localScale = new Vector3(mirrorX ? -scale : scale, scale, scale);
        }

        private static void BuildEquipmentFallback(Transform parent)
        {
            var bodyMaterial = CreateMaterial("Fallback painted steel", new Color(0.18f, 0.32f, 0.42f), 0.35f, 0.55f);
            var darkMaterial = CreateMaterial("Fallback dark metal", new Color(0.055f, 0.065f, 0.075f), 0.72f, 0.5f);
            CreatePrimitive("Body", PrimitiveType.Cube, parent, new Vector3(0f, 1.35f, 0f), new Vector3(3.8f, 2.7f, 2.2f), bodyMaterial);
            CreatePrimitive("Door", PrimitiveType.Cube, parent, new Vector3(0f, 1.35f, -1.14f), new Vector3(2.4f, 2.1f, 0.12f), darkMaterial);
            CreatePrimitive("Roof", PrimitiveType.Cube, parent, new Vector3(0f, 2.85f, 0f), new Vector3(3.45f, 0.25f, 1.9f), darkMaterial);
        }

        private static void BuildTransferCartFallback(Transform parent)
        {
            var steel = CreateMaterial("Fallback cart steel", new Color(0.23f, 0.27f, 0.3f), 0.75f, 0.42f);
            var accent = CreateMaterial("Fallback cart accent", new Color(0.82f, 0.34f, 0.08f), 0.2f, 0.5f);
            CreatePrimitive("CartDeck", PrimitiveType.Cube, parent, new Vector3(0f, 0.55f, 0f), new Vector3(3.2f, 0.35f, 2.1f), steel);
            CreatePrimitive("CartFrame", PrimitiveType.Cube, parent, new Vector3(0f, 1.05f, 0f), new Vector3(2.6f, 0.65f, 1.6f), accent);
            for (var x = -1; x <= 1; x += 2)
            {
                for (var z = -1; z <= 1; z += 2)
                {
                    var wheel = CreatePrimitive("Wheel", PrimitiveType.Cylinder, parent, new Vector3(x * 1.15f, 0.25f, z * 0.72f), new Vector3(0.34f, 0.18f, 0.34f), steel);
                    wheel.transform.localRotation = Quaternion.Euler(0f, 0f, 90f);
                }
            }
        }

        private static GameObject CreatePrimitive(
            string name,
            PrimitiveType primitiveType,
            Transform parent,
            Vector3 position,
            Vector3 scale,
            Material material)
        {
            var value = GameObject.CreatePrimitive(primitiveType);
            value.name = name;
            value.transform.SetParent(parent, false);
            value.transform.localPosition = position;
            value.transform.localScale = scale;
            var renderer = value.GetComponent<Renderer>();
            if (renderer != null) renderer.sharedMaterial = material;
            var collider = value.GetComponent<Collider>();
            if (collider != null) Destroy(collider);
            return value;
        }

        private static Material CreateMaterial(string name, Color color, float metallic, float smoothness)
        {
            var material = RuntimeShaderLibrary.CreateLitMaterial(name);
            material.color = color;
            if (material.HasProperty("_BaseColor")) material.SetColor("_BaseColor", color);
            if (material.HasProperty("_Metallic")) material.SetFloat("_Metallic", metallic);
            if (material.HasProperty("_Smoothness")) material.SetFloat("_Smoothness", smoothness);
            return material;
        }

        private void OnDestroy()
        {
            foreach (var template in _templates.Values)
            {
                if (template.Root != null) Destroy(template.Root);
                template.Importer?.Dispose();
            }
            _templates.Clear();
        }
    }
}
