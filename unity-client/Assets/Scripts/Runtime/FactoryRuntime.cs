using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using HeatTreatment.DigitalTwin.Backend;
using HeatTreatment.DigitalTwin.Core;
using HeatTreatment.DigitalTwin.Rendering;
using Newtonsoft.Json.Linq;
using UnityEngine;

namespace HeatTreatment.DigitalTwin.Runtime
{
    [DefaultExecutionOrder(-500)]
    public sealed class FactoryRuntime : MonoBehaviour
    {
        private sealed class DevicePlacement
        {
            public DeviceDto Device;
            public Transform Parent;
        }

        private static FactoryRuntime _instance;
        private readonly Dictionary<string, ModelBindingDriver> _drivers = new Dictionary<string, ModelBindingDriver>();
        private readonly Dictionary<string, DeviceStatusVisual> _visuals = new Dictionary<string, DeviceStatusVisual>();
        private readonly Dictionary<string, JObject> _latestDeviceFrames = new Dictionary<string, JObject>();

        private NativeClientSettings _settings;
        private BackendApiClient _api;
        private RealtimeWebSocketClient _webSocket;
        private RuntimeModelLibrary _modelLibrary;
        private NativeQualityController _quality;
        private FactoryEnvironmentBuilder _environment;
        private RuntimeDiagnosticsOverlay _diagnostics;
        private CancellationTokenSource _lifetime;
        private CancellationTokenSource _reload;
        private Transform _factoryRoot;
        private Camera _camera;

        [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.AfterSceneLoad)]
        private static void EnsureRuntimeExists()
        {
            if (FindObjectOfType<FactoryRuntime>() != null) return;
            new GameObject("DigitalTwinRuntime").AddComponent<FactoryRuntime>();
        }

        private void Awake()
        {
            if (_instance != null && _instance != this)
            {
                Destroy(gameObject);
                return;
            }
            _instance = this;
            Application.runInBackground = true;
            _lifetime = new CancellationTokenSource();
            _settings = NativeClientSettings.Load();
            _api = new BackendApiClient(_settings.backendHttpUrl);

            _environment = GetOrAdd<FactoryEnvironmentBuilder>();
            _camera = _environment.EnsureCamera();
            _environment.BuildLightingAndPostProcessing();

            _quality = GetOrAdd<NativeQualityController>();
            _quality.Configure(_settings);

            _diagnostics = GetOrAdd<RuntimeDiagnosticsOverlay>();
            _diagnostics.Visible = _settings.showDiagnostics;
            _diagnostics.QualityController = _quality;

            _modelLibrary = GetOrAdd<RuntimeModelLibrary>();
            _webSocket = GetOrAdd<RealtimeWebSocketClient>();
            _webSocket.MessageReceived += OnRealtimeMessage;
            _webSocket.ConnectionStateChanged += OnConnectionStateChanged;
            try
            {
                _webSocket.StartClient(_settings.backendWebSocketUrl, _settings.autoReconnectSeconds);
            }
            catch (Exception exception)
            {
                _diagnostics.BackendState = "invalid websocket URL";
                Debug.LogError($"[FactoryRuntime] WebSocket startup failed: {exception}");
            }
        }

        private void Start()
        {
            BeginReload();
        }

        private void Update()
        {
            if (Input.GetKeyDown(KeyCode.F5)) BeginReload();
        }

        private void BeginReload()
        {
            _reload?.Cancel();
            _reload?.Dispose();
            _reload = CancellationTokenSource.CreateLinkedTokenSource(_lifetime.Token);
            DestroyCurrentFactory();
            _ = LoadConfigurationLoopAsync(_reload.Token);
        }

        private async Task LoadConfigurationLoopAsync(CancellationToken cancellationToken)
        {
            var retry = Mathf.Max(1f, _settings.configurationRetrySeconds);
            while (!cancellationToken.IsCancellationRequested)
            {
                try
                {
                    _diagnostics.Activity = "Reading factory configuration";
                    var config = await _api.GetFactoryConfigAsync(cancellationToken);
                    await BuildFactoryAsync(config, cancellationToken);
                    return;
                }
                catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
                {
                    return;
                }
                catch (Exception exception)
                {
                    _diagnostics.BackendState = "configuration offline";
                    _diagnostics.Activity = $"Config retry in {retry:0}s: {ShortMessage(exception.Message)}";
                    Debug.LogWarning($"[FactoryRuntime] Configuration unavailable: {exception.Message}");
                    try { await Task.Delay(TimeSpan.FromSeconds(retry), cancellationToken); }
                    catch (OperationCanceledException) { return; }
                }
            }
        }

        private async Task BuildFactoryAsync(FactoryConfigDto config, CancellationToken cancellationToken)
        {
            DestroyCurrentFactory();
            var root = new GameObject("RuntimeFactory");
            root.transform.SetParent(transform, false);
            _factoryRoot = root.transform;

            if (config.Settings != null
                && config.Settings.TryGetValue("native_quality_profile", out var backendQuality)
                && !string.IsNullOrWhiteSpace(backendQuality)
                && !string.Equals(backendQuality, "auto", StringComparison.OrdinalIgnoreCase)
                && string.Equals(_settings.qualityProfile, "auto", StringComparison.OrdinalIgnoreCase))
            {
                _quality.Apply(backendQuality, false);
            }

            var placements = CreateHierarchy(config, _factoryRoot);
            var devices = placements.Select(placement => placement.Device).ToList();
            _diagnostics.DeviceCount = devices.Count;
            _diagnostics.ReadyDeviceCount = 0;
            _diagnostics.FallbackDeviceCount = 0;
            _diagnostics.BackendState = "configuration online";
            _environment.RebuildFactoryFloor(config, devices);
            _modelLibrary.Configure(_settings.backendHttpUrl, config.Models, _settings.modelLoadTimeoutSeconds);

            foreach (var placement in placements)
            {
                cancellationToken.ThrowIfCancellationRequested();
                var device = placement.Device;
                _diagnostics.Activity = $"Loading {device.Name ?? device.Id}";
                var instance = await _modelLibrary.InstantiateAsync(device, placement.Parent, cancellationToken);
                var driver = instance.Root.GetComponent<ModelBindingDriver>();
                var visual = instance.Root.AddComponent<DeviceStatusVisual>();
                visual.Initialize(device);
                if (!string.IsNullOrWhiteSpace(device.Id))
                {
                    _drivers[device.Id] = driver;
                    _visuals[device.Id] = visual;
                    if (_latestDeviceFrames.TryGetValue(device.Id, out var latest))
                    {
                        driver.ApplyRealtime(latest);
                        visual.ApplyRealtime(latest);
                    }
                }
                _diagnostics.ReadyDeviceCount += 1;
                if (instance.IsFallback) _diagnostics.FallbackDeviceCount += 1;
                _diagnostics.TemplateCount = _modelLibrary.LoadedTemplateCount;
                await Task.Yield();
            }

            var bounds = CalculateRendererBounds(_factoryRoot);
            _camera.GetComponent<OrbitCameraController>()?.FrameBounds(bounds, true);
            _environment.RefreshReflectionProbe();
            _diagnostics.Activity = _diagnostics.FallbackDeviceCount == 0
                ? "Native factory ready"
                : "Factory ready; one or more model files used fallback geometry";
            Debug.Log(
                $"[FactoryRuntime] {_diagnostics.Activity}: devices={_diagnostics.ReadyDeviceCount}, "
                + $"fallback={_diagnostics.FallbackDeviceCount}, templates={_diagnostics.TemplateCount}"
            );
        }

        private static List<DevicePlacement> CreateHierarchy(FactoryConfigDto config, Transform root)
        {
            var result = new List<DevicePlacement>();
            foreach (var workshop in config.Workshops ?? new List<WorkshopDto>())
            {
                var workshopRoot = new GameObject(string.IsNullOrWhiteSpace(workshop.Name) ? workshop.Id : workshop.Name);
                workshopRoot.transform.SetParent(root, false);
                foreach (var line in workshop.Lines ?? new List<LineDto>())
                {
                    var lineRoot = new GameObject(string.IsNullOrWhiteSpace(line.Name) ? line.Id : line.Name);
                    lineRoot.transform.SetParent(workshopRoot.transform, false);
                    foreach (var device in line.Devices ?? new List<DeviceDto>())
                    {
                        result.Add(new DevicePlacement { Device = device, Parent = lineRoot.transform });
                    }
                }
                foreach (var device in workshop.Devices ?? new List<DeviceDto>())
                {
                    result.Add(new DevicePlacement { Device = device, Parent = workshopRoot.transform });
                }
            }
            return result;
        }

        private void OnRealtimeMessage(JObject message)
        {
            var type = message.Value<string>("type");
            if (type == "realtime_frame")
            {
                var payload = message["payload"] as JObject;
                var devices = payload?["devices"] as JArray;
                if (devices == null) return;
                foreach (var token in devices)
                {
                    if (!(token is JObject deviceData)) continue;
                    var id = deviceData.Value<string>("furnace_id");
                    if (string.IsNullOrWhiteSpace(id)) continue;
                    _latestDeviceFrames[id] = deviceData;
                    if (_drivers.TryGetValue(id, out var driver)) driver.ApplyRealtime(deviceData);
                    if (_visuals.TryGetValue(id, out var visual)) visual.ApplyRealtime(deviceData);
                }
                _diagnostics.RecordRealtimeFrame(payload.Value<long?>("timestamp") ?? 0L, devices.Count);
            }
            else if (type == "plc_status")
            {
                var payload = message["payload"] as JObject;
                _diagnostics.PlcState = payload?.Value<string>("status")
                    ?? payload?.Value<string>("message")
                    ?? "updated";
            }
        }

        private void OnConnectionStateChanged(string state)
        {
            _diagnostics.BackendState = state ?? "unknown";
        }

        private void DestroyCurrentFactory()
        {
            _drivers.Clear();
            _visuals.Clear();
            if (_factoryRoot != null) Destroy(_factoryRoot.gameObject);
            _factoryRoot = null;
            if (_diagnostics != null)
            {
                _diagnostics.ReadyDeviceCount = 0;
                _diagnostics.DeviceCount = 0;
                _diagnostics.FallbackDeviceCount = 0;
            }
        }

        private static Bounds CalculateRendererBounds(Transform root)
        {
            var renderers = root.GetComponentsInChildren<Renderer>(false)
                .Where(renderer => renderer.enabled)
                .ToArray();
            if (renderers.Length == 0) return new Bounds(Vector3.zero, new Vector3(40f, 10f, 30f));
            var bounds = renderers[0].bounds;
            for (var index = 1; index < renderers.Length; index += 1) bounds.Encapsulate(renderers[index].bounds);
            bounds.Expand(new Vector3(4f, 2f, 4f));
            return bounds;
        }

        private T GetOrAdd<T>() where T : Component
        {
            return GetComponent<T>() ?? gameObject.AddComponent<T>();
        }

        private static string ShortMessage(string value)
        {
            if (string.IsNullOrWhiteSpace(value)) return "unknown error";
            return value.Length <= 86 ? value : value.Substring(0, 83) + "...";
        }

        private void OnDestroy()
        {
            if (_instance == this) _instance = null;
            if (_webSocket != null)
            {
                _webSocket.MessageReceived -= OnRealtimeMessage;
                _webSocket.ConnectionStateChanged -= OnConnectionStateChanged;
                _webSocket.StopClient();
            }
            _reload?.Cancel();
            _reload?.Dispose();
            _lifetime?.Cancel();
            _lifetime?.Dispose();
        }
    }

    public sealed class DeviceStatusVisual : MonoBehaviour
    {
        private Renderer _renderer;
        private Material _material;
        private Color _lastColor = Color.clear;

        public void Initialize(DeviceDto device)
        {
            var config = device?.InstanceConfigObject ?? new JObject();
            var labelY = config.Value<float?>("statusLightY") ?? config.Value<float?>("labelY") ?? 3.2f;
            var marker = GameObject.CreatePrimitive(PrimitiveType.Sphere);
            marker.name = "Runtime Status Beacon";
            marker.transform.SetParent(transform, false);
            marker.transform.localPosition = new Vector3(0f, labelY, 0f);
            marker.transform.localScale = Vector3.one * 0.14f;
            var collider = marker.GetComponent<Collider>();
            if (collider != null) Destroy(collider);
            _renderer = marker.GetComponent<Renderer>();
            _material = RuntimeShaderLibrary.CreateLitMaterial($"{device?.Id} status beacon");
            _material.EnableKeyword("_EMISSION");
            _renderer.sharedMaterial = _material;
            SetColor(new Color(0.28f, 0.32f, 0.35f));
        }

        public void ApplyRealtime(JObject data)
        {
            var quality = TokenString(data?["status"]?["quality"])
                ?? TokenString(data?["quality"]?["overall"])
                ?? TokenString(data?["quality"]);
            var alarm = ToBool(data?["status"]?["alarm"]);
            var running = ToBool(data?["status"]?["running"]);
            if (string.Equals(quality, "bad", StringComparison.OrdinalIgnoreCase)) SetColor(new Color(0.95f, 0.18f, 0.13f));
            else if (string.Equals(quality, "stale", StringComparison.OrdinalIgnoreCase)) SetColor(new Color(1f, 0.52f, 0.12f));
            else if (alarm) SetColor(new Color(1f, 0.06f, 0.035f));
            else if (running) SetColor(new Color(0.04f, 1f, 0.48f));
            else SetColor(new Color(0.25f, 0.31f, 0.34f));
        }

        private void SetColor(Color color)
        {
            if (_material == null || color == _lastColor) return;
            _lastColor = color;
            _material.color = color;
            if (_material.HasProperty("_BaseColor")) _material.SetColor("_BaseColor", color);
            if (_material.HasProperty("_EmissionColor")) _material.SetColor("_EmissionColor", color * 2.2f);
        }

        private static bool ToBool(JToken token)
        {
            if (token == null) return false;
            if (token.Type == JTokenType.Boolean) return token.Value<bool>();
            if (token.Type == JTokenType.Integer || token.Type == JTokenType.Float) return Math.Abs(token.Value<double>()) > double.Epsilon;
            var value = token.Value<string>()?.ToLowerInvariant();
            return value == "1" || value == "true" || value == "on" || value == "running" || value == "alarm";
        }

        private static string TokenString(JToken token)
        {
            if (token == null || token.Type == JTokenType.Null || token.Type == JTokenType.Object || token.Type == JTokenType.Array)
            {
                return null;
            }
            return token.ToString();
        }

        private void OnDestroy()
        {
            if (_material != null) Destroy(_material);
        }
    }
}
