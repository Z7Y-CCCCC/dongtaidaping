using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using HeatTreatment.DigitalTwin.Backend;
using HeatTreatment.DigitalTwin.Rendering;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using UnityEngine;

namespace HeatTreatment.DigitalTwin.Runtime
{
    /// <summary>
    /// Native two-level presentation shell:
    /// factory overview -> click a device -> focused equipment detail.
    /// It intentionally uses the authored PBR materials without neon edge rendering.
    /// </summary>
    public sealed class FactoryDashboardController : MonoBehaviour
    {
        private enum DashboardMode
        {
            Overview,
            Detail
        }

        private sealed class DeviceView
        {
            public DeviceDto Device;
            public GameObject Root;
            public Bounds WorldBounds;
            public string LineName;
            public JObject Frame;
            public float LastHistoryAt;
            public readonly Dictionary<string, List<float>> History = new Dictionary<string, List<float>>();
        }

        private sealed class DashboardPanelConfig
        {
            [JsonProperty("visible")] public bool Visible { get; set; } = true;
            [JsonProperty("width")] public float Width { get; set; } = 326f;
            [JsonProperty("height")] public float Height { get; set; } = 824f;
            [JsonProperty("opacity")] public float Opacity { get; set; } = 1f;
            [JsonProperty("maxDevices")] public int MaxDevices { get; set; } = 20;
            [JsonProperty("maxPoints")] public int MaxPoints { get; set; } = 6;
            [JsonProperty("maxCharts")] public int MaxCharts { get; set; } = 3;
        }

        private sealed class DashboardOverviewConfig
        {
            [JsonProperty("left")] public DashboardPanelConfig Left { get; set; } = new DashboardPanelConfig();
            [JsonProperty("right")] public DashboardPanelConfig Right { get; set; } = new DashboardPanelConfig
            {
                MaxDevices = 20
            };
        }

        private sealed class DashboardDetailConfig
        {
            [JsonProperty("left")] public DashboardPanelConfig Left { get; set; } = new DashboardPanelConfig
            {
                Height = 742f,
                MaxPoints = 6
            };
            [JsonProperty("right")] public DashboardPanelConfig Right { get; set; } = new DashboardPanelConfig
            {
                Height = 742f,
                MaxPoints = 24
            };
            [JsonProperty("trends")] public DashboardPanelConfig Trends { get; set; } = new DashboardPanelConfig
            {
                Width = 1160f,
                Height = 192f,
                MaxCharts = 3
            };
        }

        private sealed class DashboardDeviceOverride
        {
            [JsonProperty("analogPointIds")] public List<string> AnalogPointIds { get; set; } = new List<string>();
            [JsonProperty("statusPointIds")] public List<string> StatusPointIds { get; set; } = new List<string>();
            [JsonProperty("trendPointIds")] public List<string> TrendPointIds { get; set; } = new List<string>();
        }

        private sealed class NativeDashboardConfig
        {
            [JsonProperty("version")] public int Version { get; set; } = 1;
            [JsonProperty("uiScale")] public float UiScale { get; set; } = 1f;
            [JsonProperty("sideMargin")] public float SideMargin { get; set; } = 24f;
            [JsonProperty("showHeader")] public bool ShowHeader { get; set; } = true;
            [JsonProperty("showWorldLabels")] public bool ShowWorldLabels { get; set; } = true;
            [JsonProperty("showBottomHints")] public bool ShowBottomHints { get; set; } = true;
            [JsonProperty("overview")] public DashboardOverviewConfig Overview { get; set; } = new DashboardOverviewConfig();
            [JsonProperty("detail")] public DashboardDetailConfig Detail { get; set; } = new DashboardDetailConfig();
            [JsonProperty("deviceOverrides")] public Dictionary<string, DashboardDeviceOverride> DeviceOverrides { get; set; }
                = new Dictionary<string, DashboardDeviceOverride>();
        }

        private const float DesignWidth = 1920f;
        private const float DesignHeight = 1080f;
        private const int HistoryLimit = 72;

        private readonly Dictionary<string, DeviceView> _devices = new Dictionary<string, DeviceView>();
        private readonly Dictionary<string, string> _lineNames = new Dictionary<string, string>();

        private Camera _camera;
        private OrbitCameraController _orbit;
        private RuntimeDiagnosticsOverlay _diagnostics;
        private FactoryConfigDto _config;
        private Bounds _factoryBounds;
        private DeviceView _selected;
        private DashboardMode _mode = DashboardMode.Overview;
        private string _factoryName = "智能热处理数字孪生控制中心";
        private string _backendState = "starting";
        private string _plcState = "unknown";
        private float _uiScale = 1f;
        private Vector2 _uiOffset;
        private Vector2 _pointerDown;
        private Vector2 _deviceScroll;
        private Vector2 _pointScroll;
        private float _uiBlend = 1f;
        private NativeDashboardConfig _dashboardConfig = new NativeDashboardConfig();

        private Texture2D _whiteTexture;
        private Texture2D _buttonTexture;
        private Texture2D _buttonHoverTexture;
        private Texture2D _buttonActiveTexture;
        private Font _font;
        private GUIStyle _brandStyle;
        private GUIStyle _headerStyle;
        private GUIStyle _sectionStyle;
        private GUIStyle _bodyStyle;
        private GUIStyle _mutedStyle;
        private GUIStyle _smallStyle;
        private GUIStyle _metricStyle;
        private GUIStyle _metricValueStyle;
        private GUIStyle _buttonStyle;
        private GUIStyle _centerStyle;

        private static readonly Color Background = new Color(0.012f, 0.027f, 0.043f, 0.96f);
        private static readonly Color Panel = new Color(0.025f, 0.059f, 0.086f, 0.91f);
        private static readonly Color PanelStrong = new Color(0.032f, 0.075f, 0.108f, 0.96f);
        private static readonly Color PanelSoft = new Color(0.05f, 0.095f, 0.125f, 0.72f);
        private static readonly Color Border = new Color(0.18f, 0.39f, 0.52f, 0.72f);
        private static readonly Color Accent = new Color(0.24f, 0.69f, 0.88f, 1f);
        private static readonly Color AccentSoft = new Color(0.18f, 0.46f, 0.62f, 0.72f);
        private static readonly Color Good = new Color(0.18f, 0.78f, 0.52f, 1f);
        private static readonly Color Warning = new Color(0.96f, 0.62f, 0.19f, 1f);
        private static readonly Color Bad = new Color(0.91f, 0.25f, 0.22f, 1f);
        private static readonly Color Text = new Color(0.89f, 0.95f, 0.98f, 1f);
        private static readonly Color Muted = new Color(0.52f, 0.66f, 0.73f, 1f);

        public string BackendState
        {
            get => _backendState;
            set => _backendState = string.IsNullOrWhiteSpace(value) ? "unknown" : value;
        }

        public string PlcState
        {
            get => _plcState;
            set => _plcState = string.IsNullOrWhiteSpace(value) ? "unknown" : value;
        }

        public void Initialize(
            Camera runtimeCamera,
            OrbitCameraController orbit,
            RuntimeDiagnosticsOverlay diagnostics)
        {
            _camera = runtimeCamera;
            _orbit = orbit;
            _diagnostics = diagnostics;
        }

        public void BeginFactory(FactoryConfigDto config)
        {
            ClearFactory();
            _config = config;
            _lineNames.Clear();
            ApplySettings(config?.Settings);

            foreach (var workshop in config?.Workshops ?? new List<WorkshopDto>())
            {
                foreach (var line in workshop.Lines ?? new List<LineDto>())
                {
                    foreach (var device in line.Devices ?? new List<DeviceDto>())
                    {
                        if (!string.IsNullOrWhiteSpace(device.Id))
                        {
                            _lineNames[device.Id] = string.IsNullOrWhiteSpace(line.Name) ? line.Id : line.Name;
                        }
                    }
                }
                foreach (var device in workshop.Devices ?? new List<DeviceDto>())
                {
                    if (!string.IsNullOrWhiteSpace(device.Id))
                    {
                        _lineNames[device.Id] = string.IsNullOrWhiteSpace(workshop.Name)
                            ? "车间直属设备"
                            : workshop.Name;
                    }
                }
            }
        }

        public void ApplySettings(IReadOnlyDictionary<string, string> settings)
        {
            if (settings != null
                && settings.TryGetValue("factory_name", out var configuredName)
                && !string.IsNullOrWhiteSpace(configuredName))
            {
                _factoryName = configuredName;
            }

            var next = new NativeDashboardConfig();
            if (settings != null
                && settings.TryGetValue("native_dashboard_config", out var serialized)
                && !string.IsNullOrWhiteSpace(serialized))
            {
                try
                {
                    next = JsonConvert.DeserializeObject<NativeDashboardConfig>(serialized)
                        ?? new NativeDashboardConfig();
                }
                catch (Exception exception)
                {
                    Debug.LogWarning($"[FactoryDashboard] Invalid component configuration: {exception.Message}");
                }
            }
            _dashboardConfig = NormalizeDashboardConfig(next);
        }

        public void RegisterDevice(DeviceDto device, GameObject root)
        {
            if (device == null || root == null || string.IsNullOrWhiteSpace(device.Id)) return;
            _devices[device.Id] = new DeviceView
            {
                Device = device,
                Root = root,
                WorldBounds = CalculateBounds(root),
                LineName = _lineNames.TryGetValue(device.Id, out var lineName) ? lineName : "未分配产线"
            };
        }

        public void CompleteFactory(Bounds factoryBounds)
        {
            _factoryBounds = factoryBounds;
            ShowOverview(true);
            if (_diagnostics != null) _diagnostics.Visible = false;
        }

        public void ApplyRealtime(string deviceId, JObject frame)
        {
            if (string.IsNullOrWhiteSpace(deviceId) || !_devices.TryGetValue(deviceId, out var device)) return;
            device.Frame = frame;
            var now = Time.realtimeSinceStartup;
            if (now - device.LastHistoryAt < 0.7f) return;
            device.LastHistoryAt = now;

            foreach (var point in TrendPoints(device.Device))
            {
                if (!TryPointNumber(device, point, out var value)) continue;
                var key = PointKey(point);
                if (!device.History.TryGetValue(key, out var values))
                {
                    values = new List<float>();
                    device.History[key] = values;
                }
                values.Add(value);
                if (values.Count > HistoryLimit) values.RemoveRange(0, values.Count - HistoryLimit);
            }
        }

        public void ClearFactory()
        {
            foreach (var entry in _devices.Values)
            {
                if (entry.Root != null) entry.Root.SetActive(true);
            }
            _devices.Clear();
            _selected = null;
            _mode = DashboardMode.Overview;
            _deviceScroll = Vector2.zero;
            _pointScroll = Vector2.zero;
        }

        private void Update()
        {
            UpdateCanvasMetrics();
            _uiBlend = Mathf.MoveTowards(_uiBlend, 1f, Time.unscaledDeltaTime * 4.2f);
            var pointer = ScreenToDesign(Input.mousePosition);
            if (_orbit != null) _orbit.PointerInputBlocked = IsPointerOverDashboard(pointer);

            if (_mode == DashboardMode.Detail
                && (Input.GetKeyDown(KeyCode.Escape) || Input.GetKeyDown(KeyCode.Backspace)))
            {
                ShowOverview(false);
                return;
            }

            if (_mode != DashboardMode.Overview) return;
            if (Input.GetMouseButtonDown(0)) _pointerDown = pointer;
            if (!Input.GetMouseButtonUp(0)) return;
            if (IsPointerOverDashboard(pointer)) return;
            if (Vector2.Distance(_pointerDown, pointer) > 10f) return;
            SelectFromWorld(Input.mousePosition);
        }

        private void OnGUI()
        {
            if (_camera == null) return;
            EnsureStyles();
            UpdateCanvasMetrics();
            var oldMatrix = GUI.matrix;
            var oldColor = GUI.color;
            GUI.matrix = Matrix4x4.TRS(
                new Vector3(_uiOffset.x, _uiOffset.y, 0f),
                Quaternion.identity,
                new Vector3(_uiScale, _uiScale, 1f)
            );
            GUI.color = new Color(1f, 1f, 1f, Mathf.SmoothStep(0f, 1f, _uiBlend));

            if (_dashboardConfig.ShowHeader) DrawHeader();
            if (_mode == DashboardMode.Detail && _selected != null) DrawDetail();
            else DrawOverview();

            GUI.color = oldColor;
            GUI.matrix = oldMatrix;
        }

        private float OverviewTop => _dashboardConfig.ShowHeader ? 104f : 24f;
        private float DetailTop => _dashboardConfig.ShowHeader ? 148f : 76f;

        private Rect OverviewLeftRect()
        {
            var panel = _dashboardConfig.Overview.Left;
            return new Rect(_dashboardConfig.SideMargin, OverviewTop, panel.Width, panel.Height);
        }

        private Rect OverviewRightRect()
        {
            var panel = _dashboardConfig.Overview.Right;
            return new Rect(DesignWidth - _dashboardConfig.SideMargin - panel.Width, OverviewTop, panel.Width, panel.Height);
        }

        private Rect DetailLeftRect()
        {
            var panel = _dashboardConfig.Detail.Left;
            return new Rect(_dashboardConfig.SideMargin, DetailTop, panel.Width, panel.Height);
        }

        private Rect DetailRightRect()
        {
            var panel = _dashboardConfig.Detail.Right;
            return new Rect(DesignWidth - _dashboardConfig.SideMargin - panel.Width, DetailTop, panel.Width, panel.Height);
        }

        private Rect BottomHintRect()
        {
            var left = _mode == DashboardMode.Detail ? DetailLeftRect() : OverviewLeftRect();
            var right = _mode == DashboardMode.Detail ? DetailRightRect() : OverviewRightRect();
            var leftVisible = _mode == DashboardMode.Detail
                ? _dashboardConfig.Detail.Left.Visible
                : _dashboardConfig.Overview.Left.Visible;
            var rightVisible = _mode == DashboardMode.Detail
                ? _dashboardConfig.Detail.Right.Visible
                : _dashboardConfig.Overview.Right.Visible;
            var x = leftVisible ? left.xMax + 20f : _dashboardConfig.SideMargin;
            var rightEdge = rightVisible ? right.x - 20f : DesignWidth - _dashboardConfig.SideMargin;
            return new Rect(x, 1005f, Mathf.Max(320f, rightEdge - x), 48f);
        }

        private Rect DetailTrendRect()
        {
            var left = DetailLeftRect();
            var right = DetailRightRect();
            var x = _dashboardConfig.Detail.Left.Visible ? left.xMax + 30f : _dashboardConfig.SideMargin;
            var rightEdge = _dashboardConfig.Detail.Right.Visible ? right.x - 30f : DesignWidth - _dashboardConfig.SideMargin;
            var bottom = _dashboardConfig.ShowBottomHints ? BottomHintRect().y - 15f : DesignHeight - 24f;
            return new Rect(
                x,
                bottom - _dashboardConfig.Detail.Trends.Height,
                Mathf.Max(360f, rightEdge - x),
                _dashboardConfig.Detail.Trends.Height
            );
        }

        private Rect DetailBackRect()
        {
            return new Rect(34f, _dashboardConfig.ShowHeader ? 98f : 24f, 150f, 38f);
        }

        private void DrawHeader()
        {
            DrawSolid(new Rect(20f, 18f, 1880f, 66f), Background);
            DrawSolid(new Rect(20f, 82f, 1880f, 2f), AccentSoft);
            DrawSolid(new Rect(38f, 34f, 8f, 34f), Accent);
            GUI.Label(new Rect(58f, 26f, 490f, 30f), "热处理智能工厂", _brandStyle);
            GUI.Label(new Rect(58f, 55f, 560f, 22f), _factoryName, _mutedStyle);

            var title = _mode == DashboardMode.Detail && _selected != null
                ? $"设备运行详情  /  {_selected.Device.Name}"
                : "全厂设备运行总览";
            GUI.Label(new Rect(630f, 28f, 660f, 38f), title, _headerStyle);

            GUI.Label(
                new Rect(1515f, 27f, 350f, 24f),
                DateTime.Now.ToString("yyyy-MM-dd   HH:mm:ss"),
                _bodyStyle
            );
            DrawStatusPill(new Rect(1515f, 55f, 165f, 22f), $"后台  {FriendlyState(_backendState)}", StateColor(_backendState));
            DrawStatusPill(new Rect(1690f, 55f, 175f, 22f), $"PLC  {FriendlyState(_plcState)}", StateColor(_plcState));
        }

        private void DrawOverview()
        {
            if (_dashboardConfig.Overview.Left.Visible) DrawOverviewLeftPanel();
            if (_dashboardConfig.Overview.Right.Visible) DrawOverviewDeviceList();
            if (_dashboardConfig.ShowWorldLabels) DrawWorldLabels();
            if (_dashboardConfig.ShowBottomHints)
            {
                DrawBottomHint("单击设备进入详情   |   左键拖动旋转   |   右键/中键平移   |   滚轮缩放   |   F9 诊断信息");
            }
        }

        private void DrawOverviewLeftPanel()
        {
            var panel = _dashboardConfig.Overview.Left;
            var rect = OverviewLeftRect();
            WithOpacity(panel.Opacity, () =>
            {
                DrawPanel(rect, "全厂运行概况", "OVERVIEW METRICS");

                var total = _devices.Count;
                var online = _devices.Values.Count(IsOnline);
                var running = _devices.Values.Count(IsRunning);
                var alarms = _devices.Values.Count(HasAlarm);
                var x = rect.x + 18f;
                var width = rect.width - 36f;
                var gap = 12f;
                var tileWidth = (width - gap) * 0.5f;

                DrawMetricTile(new Rect(x, rect.y + 68f, tileWidth, 86f), "设备总数", total.ToString(), Accent);
                DrawMetricTile(new Rect(x + tileWidth + gap, rect.y + 68f, tileWidth, 86f), "在线设备", online.ToString(), Good);
                DrawMetricTile(new Rect(x, rect.y + 166f, tileWidth, 86f), "运行设备", running.ToString(), Good);
                DrawMetricTile(new Rect(x + tileWidth + gap, rect.y + 166f, tileWidth, 86f), "报警设备", alarms.ToString(), alarms > 0 ? Bad : Muted);

                GUI.Label(new Rect(x, rect.y + 282f, width, 26f), "设备状态分布", _sectionStyle);
                DrawProgressRow(new Rect(x, rect.y + 320f, width, 34f), "在线率", total == 0 ? 0f : online / (float)total, Good);
                DrawProgressRow(new Rect(x, rect.y + 364f, width, 34f), "运行率", total == 0 ? 0f : running / (float)total, Accent);
                DrawProgressRow(new Rect(x, rect.y + 408f, width, 34f), "报警率", total == 0 ? 0f : alarms / (float)total, alarms > 0 ? Bad : Muted);

                GUI.Label(new Rect(x, rect.y + 470f, width, 26f), "实时数据质量", _sectionStyle);
                var goodPoints = 0;
                var badPoints = 0;
                foreach (var device in _devices.Values)
                {
                    CountPointQuality(device.Frame, ref goodPoints, ref badPoints);
                }
                var qualityTotal = goodPoints + badPoints;
                DrawProgressRow(
                    new Rect(x, rect.y + 508f, width, 34f),
                    "有效点位",
                    qualityTotal == 0 ? 0f : goodPoints / (float)qualityTotal,
                    Good
                );
                DrawInfoRow(new Rect(x, rect.y + 558f, width, 30f), "有效 / 异常", $"{goodPoints} / {badPoints}");
                DrawInfoRow(new Rect(x, rect.y + 596f, width, 30f), "数据源", "现场 MySQL 数据库");
                DrawInfoRow(new Rect(x, rect.y + 634f, width, 30f), "显示模式", "原生三维总览");

                var footerY = rect.yMax - 132f;
                DrawSolid(new Rect(x, footerY, width, 1f), Border);
                GUI.Label(new Rect(x, footerY + 18f, width, 22f), "当前数据与管理后台完全一致", _bodyStyle);
                GUI.Label(new Rect(x, footerY + 48f, width, 52f), "设备位置、名称、模型和点位均直接读取后台配置。", _mutedStyle);
            });
        }

        private void DrawOverviewDeviceList()
        {
            var panel = _dashboardConfig.Overview.Right;
            var rect = OverviewRightRect();
            WithOpacity(panel.Opacity, () =>
            {
                DrawPanel(rect, "设备状态", "CLICK TO OPEN DETAIL");
                var ordered = _devices.Values
                    .OrderBy(device => device.LineName)
                    .ThenBy(device => device.Device.Name)
                    .Take(panel.MaxDevices)
                    .ToList();
                var view = new Rect(rect.x + 14f, rect.y + 62f, rect.width - 28f, rect.height - 82f);
                var contentWidth = Mathf.Max(180f, view.width - 20f);
                var contentHeight = Mathf.Max(view.height - 4f, ordered.Count * 66f + 6f);
                _deviceScroll = GUI.BeginScrollView(
                    view,
                    _deviceScroll,
                    new Rect(0f, 0f, contentWidth, contentHeight),
                    false,
                    contentHeight > view.height
                );
                for (var index = 0; index < ordered.Count; index += 1)
                {
                    var device = ordered[index];
                    var row = new Rect(0f, index * 66f, contentWidth - 4f, 58f);
                    var state = DeviceState(device);
                    var color = DeviceStateColor(device);
                    var stateWidth = Mathf.Min(88f, row.width * 0.32f);
                    var stateX = row.xMax - stateWidth - 10f;
                    var labelWidth = Mathf.Max(80f, stateX - row.x - 24f);
                    DrawSolid(row, PanelSoft);
                    DrawSolid(new Rect(row.x, row.y, 4f, row.height), color);
                    GUI.Label(new Rect(row.x + 14f, row.y + 7f, labelWidth, 23f), device.Device.Name, _bodyStyle);
                    GUI.Label(new Rect(row.x + 14f, row.y + 31f, labelWidth, 18f), device.LineName, _smallStyle);
                    DrawStatusPill(new Rect(stateX, row.y + 9f, stateWidth, 21f), state, color);
                    GUI.Label(new Rect(stateX, row.y + 34f, stateWidth, 18f), OverviewValue(device), _smallStyle);
                    if (GUI.Button(row, GUIContent.none, GUIStyle.none)) ShowDetail(device);
                }
                GUI.EndScrollView();
            });
        }

        private void DrawWorldLabels()
        {
            var leftBoundary = _dashboardConfig.Overview.Left.Visible ? OverviewLeftRect().xMax : 0f;
            var rightBoundary = _dashboardConfig.Overview.Right.Visible ? OverviewRightRect().x : DesignWidth;
            foreach (var device in _devices.Values)
            {
                if (device.Root == null || !device.Root.activeInHierarchy) continue;
                var anchor = device.WorldBounds.center + Vector3.up * (device.WorldBounds.extents.y + 0.65f);
                var screen = _camera.WorldToScreenPoint(anchor);
                if (screen.z <= 0f) continue;
                var design = ScreenPixelToDesign(screen);
                if (design.x < leftBoundary || design.x > rightBoundary || design.y < 12f || design.y > 980f) continue;
                var rect = new Rect(design.x - 74f, design.y - 23f, 148f, 43f);
                var color = DeviceStateColor(device);
                DrawSolid(rect, new Color(0.018f, 0.052f, 0.075f, 0.9f));
                DrawSolid(new Rect(rect.x, rect.y, 3f, rect.height), color);
                GUI.Label(new Rect(rect.x + 9f, rect.y + 3f, rect.width - 16f, 20f), device.Device.Name, _centerStyle);
                GUI.Label(new Rect(rect.x + 9f, rect.y + 22f, rect.width - 16f, 17f), OverviewValue(device), _smallStyle);
                if (GUI.Button(rect, GUIContent.none, GUIStyle.none)) ShowDetail(device);
            }
        }

        private void DrawDetail()
        {
            var device = _selected;
            if (GUI.Button(DetailBackRect(), "〈 返回总览", _buttonStyle)) ShowOverview(false);
            if (_dashboardConfig.Detail.Left.Visible) DrawDetailLeft(device);
            if (_dashboardConfig.Detail.Right.Visible) DrawDetailRight(device);
            if (_dashboardConfig.Detail.Trends.Visible) DrawDetailTrends(device);
            if (_dashboardConfig.ShowBottomHints)
            {
                DrawBottomHint("ESC 返回总览   |   左键拖动查看设备   |   滚轮缩放   |   F1/F2/F3 画质   |   F9 诊断信息");
            }
        }

        private void DrawDetailLeft(DeviceView device)
        {
            var panel = _dashboardConfig.Detail.Left;
            var rect = DetailLeftRect();
            WithOpacity(panel.Opacity, () =>
            {
                DrawPanel(rect, "设备运行参数", device.Device.Id);
                var x = rect.x + 18f;
                var width = rect.width - 36f;
                var stateColor = DeviceStateColor(device);
                var statusWidth = Mathf.Min(126f, width * 0.44f);
                DrawStatusPill(new Rect(x, rect.y + 60f, statusWidth, 28f), DeviceState(device), stateColor);
                GUI.Label(new Rect(x + statusWidth + 16f, rect.y + 57f, width - statusWidth - 16f, 22f), device.LineName, _bodyStyle);
                GUI.Label(new Rect(x + statusWidth + 16f, rect.y + 80f, width - statusWidth - 16f, 18f), device.Device.ModelType, _smallStyle);

                GUI.Label(new Rect(x, rect.y + 122f, width, 26f), "核心参数", _sectionStyle);
                var rowStart = rect.y + 158f;
                var infoY = rect.yMax - 210f;
                var availableRows = Mathf.Max(1, Mathf.FloorToInt((infoY - rowStart - 8f) / 58f));
                var analog = DetailAnalogPoints(device.Device)
                    .Take(Mathf.Min(panel.MaxPoints, availableRows))
                    .ToList();
                if (analog.Count == 0)
                {
                    GUI.Label(new Rect(x, rowStart + 6f, width, 28f), "此设备未配置模拟量点位", _mutedStyle);
                }
                for (var index = 0; index < analog.Count; index += 1)
                {
                    var point = analog[index];
                    var y = rowStart + index * 58f;
                    DrawSolid(new Rect(x, y, width, 48f), PanelSoft);
                    var valueWidth = Mathf.Min(112f, width * 0.4f);
                    var labelWidth = Mathf.Max(80f, width - valueWidth - 26f);
                    GUI.Label(new Rect(x + 12f, y + 5f, labelWidth, 20f), PointLabel(point), _bodyStyle);
                    GUI.Label(new Rect(x + 12f, y + 26f, labelWidth, 16f), point.PlcTag ?? string.Empty, _smallStyle);
                    var value = FormatPointValue(device, point);
                    LabelWithColor(new Rect(x + width - valueWidth - 12f, y + 8f, valueWidth, 30f), value, _metricStyle, PointQualityColor(device, point));
                }

                DrawSolid(new Rect(x, infoY, width, 1f), Border);
                DrawInfoRow(new Rect(x, infoY + 16f, width, 28f), "模型", device.Device.ModelType);
                DrawInfoRow(new Rect(x, infoY + 50f, width, 28f), "点位数量", (device.Device.DataPoints?.Count ?? 0).ToString());
                DrawInfoRow(new Rect(x, infoY + 84f, width, 28f), "通信状态", IsOnline(device) ? "数据有效" : "通信异常/等待");
            });
        }

        private void DrawDetailRight(DeviceView device)
        {
            var panel = _dashboardConfig.Detail.Right;
            var rect = DetailRightRect();
            WithOpacity(panel.Opacity, () =>
            {
                DrawPanel(rect, "状态与联锁", "REALTIME SIGNALS");
                var points = DetailStatusPoints(device.Device).Take(panel.MaxPoints).ToList();
                var view = new Rect(rect.x + 14f, rect.y + 60f, rect.width - 28f, rect.height - 82f);
                var contentWidth = Mathf.Max(180f, view.width - 20f);
                var contentHeight = Mathf.Max(view.height - 4f, points.Count * 48f + 8f);
                _pointScroll = GUI.BeginScrollView(
                    view,
                    _pointScroll,
                    new Rect(0f, 0f, contentWidth, contentHeight),
                    false,
                    contentHeight > view.height
                );
                for (var index = 0; index < points.Count; index += 1)
                {
                    var point = points[index];
                    var row = new Rect(0f, index * 48f, contentWidth - 4f, 42f);
                    var active = PointBool(device, point);
                    var alarm = string.Equals(point.PointKind, "alarm", StringComparison.OrdinalIgnoreCase);
                    var qualityColor = PointQualityColor(device, point);
                    var color = active ? (alarm ? Bad : Good) : qualityColor;
                    var valueWidth = Mathf.Min(82f, row.width * 0.3f);
                    var labelWidth = Mathf.Max(80f, row.width - valueWidth - 42f);
                    DrawSolid(row, PanelSoft);
                    DrawSolid(new Rect(row.x + 8f, row.y + 14f, 10f, 10f), color);
                    GUI.Label(new Rect(row.x + 28f, row.y + 3f, labelWidth, 20f), PointLabel(point), _bodyStyle);
                    GUI.Label(new Rect(row.x + 28f, row.y + 23f, labelWidth, 16f), point.PlcTag ?? point.Category, _smallStyle);
                    var text = FormatPointValue(device, point);
                    LabelWithColor(new Rect(row.xMax - valueWidth - 8f, row.y + 8f, valueWidth, 24f), text, _metricStyle, color);
                }
                if (points.Count == 0)
                {
                    GUI.Label(new Rect(12f, 16f, contentWidth - 24f, 28f), "此设备未配置状态点位", _mutedStyle);
                }
                GUI.EndScrollView();
            });
        }

        private void DrawDetailTrends(DeviceView device)
        {
            var panel = _dashboardConfig.Detail.Trends;
            var rect = DetailTrendRect();
            WithOpacity(panel.Opacity, () =>
            {
                DrawPanel(rect, "实时趋势", "进入详情后持续记录当前会话数据");
                var points = TrendPoints(device.Device).Take(panel.MaxCharts).ToList();
                if (points.Count == 0)
                {
                    GUI.Label(new Rect(rect.x + 34f, rect.y + 82f, rect.width - 68f, 30f), "没有可绘制的模拟量点位", _mutedStyle);
                    return;
                }

                var gap = 18f;
                var contentX = rect.x + 34f;
                var contentWidth = rect.width - 68f;
                var width = (contentWidth - gap * (points.Count - 1)) / points.Count;
                var chartHeight = Mathf.Max(74f, rect.height - 76f);
                for (var index = 0; index < points.Count; index += 1)
                {
                    var chart = new Rect(contentX + index * (width + gap), rect.y + 52f, width, chartHeight);
                    var color = index == 0 ? Accent : (index == 1 ? Warning : (index == 2 ? Good : new Color(0.72f, 0.44f, 0.94f)));
                    DrawTrendChart(device, points[index], chart, color);
                }
            });
        }

        private void DrawTrendChart(DeviceView device, DataPointDto point, Rect rect, Color color)
        {
            DrawSolid(rect, new Color(0.016f, 0.044f, 0.066f, 0.84f));
            GUI.Label(new Rect(rect.x + 10f, rect.y + 5f, rect.width - 100f, 20f), PointLabel(point), _bodyStyle);
            LabelWithColor(
                new Rect(rect.x + rect.width - 98f, rect.y + 4f, 88f, 22f),
                FormatPointValue(device, point),
                _metricStyle,
                color
            );
            var plot = new Rect(rect.x + 10f, rect.y + 31f, rect.width - 20f, rect.height - 42f);
            for (var line = 1; line < 4; line += 1)
            {
                DrawSolid(new Rect(plot.x, plot.y + plot.height * line / 4f, plot.width, 1f), new Color(0.18f, 0.31f, 0.39f, 0.35f));
            }
            if (!device.History.TryGetValue(PointKey(point), out var values) || values.Count < 2)
            {
                GUI.Label(plot, "等待有效实时数据", _centerStyle);
                return;
            }
            var minimum = values.Min();
            var maximum = values.Max();
            if (Mathf.Abs(maximum - minimum) < 0.001f)
            {
                minimum -= 0.5f;
                maximum += 0.5f;
            }
            Vector2? previous = null;
            for (var index = 0; index < values.Count; index += 1)
            {
                var x = plot.x + plot.width * index / Mathf.Max(1f, values.Count - 1f);
                var normalized = Mathf.InverseLerp(minimum, maximum, values[index]);
                var y = plot.yMax - normalized * plot.height;
                var current = new Vector2(x, y);
                if (previous.HasValue) DrawLine(previous.Value, current, color, 2f);
                previous = current;
            }
        }

        private void DrawBottomHint(string text)
        {
            var rect = BottomHintRect();
            DrawSolid(rect, new Color(0.014f, 0.04f, 0.06f, 0.9f));
            GUI.Label(new Rect(rect.x + 20f, rect.y + 12f, rect.width - 40f, 24f), text, _centerStyle);
        }

        private void ShowDetail(DeviceView device)
        {
            if (device == null || device.Root == null) return;
            _selected = device;
            _mode = DashboardMode.Detail;
            _uiBlend = 0f;
            _pointScroll = Vector2.zero;
            foreach (var entry in _devices.Values)
            {
                if (entry.Root != null) entry.Root.SetActive(entry == device);
            }
            device.WorldBounds = CalculateBounds(device.Root);
            // Keep the same authored three-quarter view regardless of the device's
            // configured factory yaw. This prevents a correctly rotated device from
            // opening on its rear side in the detail view.
            var detailYaw = Mathf.DeltaAngle(0f, device.Root.transform.eulerAngles.y + 238f);
            _orbit?.FocusBounds(device.WorldBounds, detailYaw, 19f, 1.12f, false);
        }

        private void ShowOverview(bool immediate)
        {
            _selected = null;
            _mode = DashboardMode.Overview;
            _uiBlend = immediate ? 1f : 0f;
            foreach (var entry in _devices.Values)
            {
                if (entry.Root != null) entry.Root.SetActive(true);
            }
            _orbit?.FocusBounds(_factoryBounds, -39f, 33f, 1.08f, immediate);
        }

        private void SelectFromWorld(Vector3 screenPosition)
        {
            if (_camera == null) return;
            var ray = _camera.ScreenPointToRay(screenPosition);
            DeviceView closest = null;
            var distance = float.PositiveInfinity;
            foreach (var device in _devices.Values)
            {
                if (device.Root == null || !device.Root.activeInHierarchy) continue;
                if (!device.WorldBounds.IntersectRay(ray, out var hitDistance) || hitDistance >= distance) continue;
                closest = device;
                distance = hitDistance;
            }
            if (closest != null) ShowDetail(closest);
        }

        private bool IsPointerOverDashboard(Vector2 pointer)
        {
            if (pointer.x < 0f || pointer.y < 0f || pointer.x > DesignWidth || pointer.y > DesignHeight) return true;
            if (_dashboardConfig.ShowHeader && new Rect(20f, 18f, 1880f, 66f).Contains(pointer)) return true;
            if (_dashboardConfig.ShowBottomHints && BottomHintRect().Contains(pointer)) return true;
            if (_mode == DashboardMode.Overview)
            {
                if (_dashboardConfig.Overview.Left.Visible && OverviewLeftRect().Contains(pointer)) return true;
                if (_dashboardConfig.Overview.Right.Visible && OverviewRightRect().Contains(pointer)) return true;
                return false;
            }
            if (DetailBackRect().Contains(pointer)) return true;
            if (_dashboardConfig.Detail.Left.Visible && DetailLeftRect().Contains(pointer)) return true;
            if (_dashboardConfig.Detail.Right.Visible && DetailRightRect().Contains(pointer)) return true;
            return _dashboardConfig.Detail.Trends.Visible && DetailTrendRect().Contains(pointer);
        }

        private void UpdateCanvasMetrics()
        {
            var fitScale = Mathf.Max(0.1f, Mathf.Min(Screen.width / DesignWidth, Screen.height / DesignHeight));
            _uiScale = fitScale * _dashboardConfig.UiScale;
            _uiOffset = new Vector2(
                (Screen.width - DesignWidth * _uiScale) * 0.5f,
                (Screen.height - DesignHeight * _uiScale) * 0.5f
            );
        }

        private Vector2 ScreenToDesign(Vector3 screenPoint)
        {
            return new Vector2(
                (screenPoint.x - _uiOffset.x) / _uiScale,
                (Screen.height - screenPoint.y - _uiOffset.y) / _uiScale
            );
        }

        private Vector2 ScreenPixelToDesign(Vector3 screenPoint)
        {
            return new Vector2(
                (screenPoint.x - _uiOffset.x) / _uiScale,
                (Screen.height - screenPoint.y - _uiOffset.y) / _uiScale
            );
        }

        private static Bounds CalculateBounds(GameObject root)
        {
            var renderers = root.GetComponentsInChildren<Renderer>(true)
                .Where(renderer => renderer != null && renderer.enabled)
                .ToArray();
            if (renderers.Length == 0) return new Bounds(root.transform.position, new Vector3(3f, 3f, 3f));
            var bounds = renderers[0].bounds;
            for (var index = 1; index < renderers.Length; index += 1) bounds.Encapsulate(renderers[index].bounds);
            bounds.Expand(new Vector3(0.5f, 0.5f, 0.5f));
            return bounds;
        }

        private static NativeDashboardConfig NormalizeDashboardConfig(NativeDashboardConfig value)
        {
            var config = value ?? new NativeDashboardConfig();
            config.UiScale = Mathf.Clamp(config.UiScale, 0.8f, 1.2f);
            config.SideMargin = Mathf.Clamp(config.SideMargin, 8f, 100f);
            config.Overview ??= new DashboardOverviewConfig();
            config.Detail ??= new DashboardDetailConfig();
            config.Overview.Left ??= new DashboardPanelConfig();
            config.Overview.Right ??= new DashboardPanelConfig { MaxDevices = 20 };
            config.Detail.Left ??= new DashboardPanelConfig { Height = 742f, MaxPoints = 6 };
            config.Detail.Right ??= new DashboardPanelConfig { Height = 742f, MaxPoints = 24 };
            config.Detail.Trends ??= new DashboardPanelConfig { Height = 192f, MaxCharts = 3 };

            NormalizePanel(config.Overview.Left, 260f, 520f, 800f, 900f);
            NormalizePanel(config.Overview.Right, 260f, 520f, 420f, 900f);
            NormalizePanel(config.Detail.Left, 260f, 520f, 520f, 830f);
            NormalizePanel(config.Detail.Right, 260f, 520f, 420f, 830f);
            NormalizePanel(config.Detail.Trends, 360f, 1600f, 140f, 320f);
            config.Overview.Right.MaxDevices = Mathf.Clamp(config.Overview.Right.MaxDevices, 1, 100);
            config.Detail.Left.MaxPoints = Mathf.Clamp(config.Detail.Left.MaxPoints, 1, 12);
            config.Detail.Right.MaxPoints = Mathf.Clamp(config.Detail.Right.MaxPoints, 1, 100);
            config.Detail.Trends.MaxCharts = Mathf.Clamp(config.Detail.Trends.MaxCharts, 1, 4);

            var overrides = new Dictionary<string, DashboardDeviceOverride>();
            foreach (var entry in config.DeviceOverrides ?? new Dictionary<string, DashboardDeviceOverride>())
            {
                if (string.IsNullOrWhiteSpace(entry.Key) || entry.Value == null) continue;
                entry.Value.AnalogPointIds = SanitizePointIds(entry.Value.AnalogPointIds);
                entry.Value.StatusPointIds = SanitizePointIds(entry.Value.StatusPointIds);
                entry.Value.TrendPointIds = SanitizePointIds(entry.Value.TrendPointIds);
                overrides[entry.Key] = entry.Value;
            }
            config.DeviceOverrides = overrides;
            return config;
        }

        private static void NormalizePanel(
            DashboardPanelConfig panel,
            float minimumWidth,
            float maximumWidth,
            float minimumHeight,
            float maximumHeight)
        {
            panel.Width = Mathf.Clamp(panel.Width, minimumWidth, maximumWidth);
            panel.Height = Mathf.Clamp(panel.Height, minimumHeight, maximumHeight);
            panel.Opacity = Mathf.Clamp(panel.Opacity, 0.25f, 1f);
        }

        private static List<string> SanitizePointIds(IEnumerable<string> values)
        {
            return (values ?? Enumerable.Empty<string>())
                .Select(value => value?.Trim())
                .Where(value => !string.IsNullOrWhiteSpace(value))
                .Distinct()
                .Take(200)
                .ToList();
        }

        private DashboardDeviceOverride DeviceOverride(DeviceDto device)
        {
            if (device == null || string.IsNullOrWhiteSpace(device.Id)) return null;
            return _dashboardConfig.DeviceOverrides.TryGetValue(device.Id, out var value) ? value : null;
        }

        private IEnumerable<DataPointDto> DetailAnalogPoints(DeviceDto device)
        {
            return SelectConfiguredPoints(device, AnalogPoints(device), DeviceOverride(device)?.AnalogPointIds);
        }

        private IEnumerable<DataPointDto> DetailStatusPoints(DeviceDto device)
        {
            var candidates = (device?.DataPoints ?? new List<DataPointDto>())
                .Where(point => !string.Equals(point.Category, "analog", StringComparison.OrdinalIgnoreCase))
                .OrderByDescending(point => string.Equals(point.PointKind, "alarm", StringComparison.OrdinalIgnoreCase))
                .ThenBy(point => point.Category)
                .ThenBy(point => point.Label);
            return SelectConfiguredPoints(device, candidates, DeviceOverride(device)?.StatusPointIds);
        }

        private IEnumerable<DataPointDto> TrendPoints(DeviceDto device)
        {
            return SelectConfiguredPoints(device, AnalogPoints(device), DeviceOverride(device)?.TrendPointIds)
                .Take(_dashboardConfig.Detail.Trends.MaxCharts);
        }

        private static IEnumerable<DataPointDto> SelectConfiguredPoints(
            DeviceDto device,
            IEnumerable<DataPointDto> candidates,
            IReadOnlyList<string> configuredIds)
        {
            var available = (candidates ?? Enumerable.Empty<DataPointDto>()).ToList();
            if (configuredIds == null || configuredIds.Count == 0) return available;
            var byId = available
                .GroupBy(point => point.Id.ToString(CultureInfo.InvariantCulture))
                .ToDictionary(group => group.Key, group => group.First());
            return configuredIds
                .Where(id => !string.IsNullOrWhiteSpace(id) && byId.ContainsKey(id))
                .Select(id => byId[id])
                .ToList();
        }

        private static IEnumerable<DataPointDto> AnalogPoints(DeviceDto device)
        {
            return (device?.DataPoints ?? new List<DataPointDto>())
                .Where(point => string.Equals(point.Category, "analog", StringComparison.OrdinalIgnoreCase));
        }

        private static string PointKey(DataPointDto point)
        {
            return string.IsNullOrWhiteSpace(point?.ValueRole) ? point?.Name ?? string.Empty : point.ValueRole;
        }

        private static string PointLabel(DataPointDto point)
        {
            if (!string.IsNullOrWhiteSpace(point?.Label)) return point.Label;
            if (!string.IsNullOrWhiteSpace(point?.Name)) return point.Name;
            return "未命名点位";
        }

        private static JToken PointToken(DeviceView device, DataPointDto point)
        {
            if (device?.Frame == null || point == null) return null;
            var category = string.IsNullOrWhiteSpace(point.Category) ? "analog" : point.Category;
            var key = PointKey(point);
            return device.Frame[category]?[key]
                ?? device.Frame[category]?[point.Name]
                ?? device.Frame.SelectToken($"{category}.{key}");
        }

        private static string PointQuality(DeviceView device, DataPointDto point)
        {
            if (device?.Frame == null || point == null) return "bad";
            var category = string.IsNullOrWhiteSpace(point.Category) ? "analog" : point.Category;
            var key = PointKey(point);
            return device.Frame["quality"]?[category]?[key]?.ToString()
                ?? device.Frame["quality"]?[category]?[point.Name]?.ToString()
                ?? "bad";
        }

        private static bool TryPointNumber(DeviceView device, DataPointDto point, out float value)
        {
            value = 0f;
            var token = PointToken(device, point);
            if (token == null || token.Type == JTokenType.Null) return false;
            return float.TryParse(token.ToString(), NumberStyles.Float, CultureInfo.InvariantCulture, out value);
        }

        private static bool PointBool(DeviceView device, DataPointDto point)
        {
            return TokenBool(PointToken(device, point));
        }

        private static bool TokenBool(JToken token)
        {
            if (token == null || token.Type == JTokenType.Null) return false;
            if (token.Type == JTokenType.Boolean) return token.Value<bool>();
            if (token.Type == JTokenType.Integer || token.Type == JTokenType.Float) return Math.Abs(token.Value<double>()) > double.Epsilon;
            var value = token.ToString().Trim().ToLowerInvariant();
            return value == "1" || value == "true" || value == "on" || value == "running" || value == "alarm";
        }

        private static string FormatPointValue(DeviceView device, DataPointDto point)
        {
            var token = PointToken(device, point);
            if (token == null || token.Type == JTokenType.Null) return "--";
            if (string.Equals(point.DataType, "BOOL", StringComparison.OrdinalIgnoreCase)
                || token.Type == JTokenType.Boolean)
            {
                return TokenBool(token) ? "开启" : "关闭";
            }
            var text = token.ToString();
            if (double.TryParse(text, NumberStyles.Float, CultureInfo.InvariantCulture, out var number))
            {
                var format = string.IsNullOrWhiteSpace(point.DisplayFormat) ? "0.##" : point.DisplayFormat;
                try { text = number.ToString(format, CultureInfo.InvariantCulture); }
                catch (FormatException) { text = number.ToString("0.##", CultureInfo.InvariantCulture); }
            }
            var unit = string.IsNullOrWhiteSpace(point.Unit) ? InferUnit(PointLabel(point)) : point.Unit;
            return string.IsNullOrWhiteSpace(unit) ? text : $"{text} {unit}";
        }

        private static string InferUnit(string label)
        {
            if (label.Contains("温度")) return "℃";
            if (label.Contains("碳势")) return "%";
            if (label.Contains("压力")) return "Pa";
            if (label.Contains("转速")) return "rpm";
            return string.Empty;
        }

        private static bool IsOnline(DeviceView device)
        {
            if (device?.Frame == null) return false;
            var values = LeafValues(device.Frame["quality"])
                .Select(value => value.ToString())
                .Where(value => !string.IsNullOrWhiteSpace(value))
                .ToList();
            if (values.Count == 0) return true;
            return values.Any(value => string.Equals(value, "good", StringComparison.OrdinalIgnoreCase));
        }

        private static bool IsRunning(DeviceView device)
        {
            if (device?.Frame == null) return false;
            foreach (var categoryName in new[] { "status", "motors", "mechanisms" })
            {
                if (!(device.Frame[categoryName] is JObject category)) continue;
                foreach (var property in category.Properties())
                {
                    var name = property.Name.ToLowerInvariant();
                    if ((name.Contains("run") || name.Contains("fan") || name.Contains("stir") || name.Contains("运行"))
                        && TokenBool(property.Value)) return true;
                }
            }
            return false;
        }

        private static bool HasAlarm(DeviceView device)
        {
            foreach (var point in device?.Device?.DataPoints ?? new List<DataPointDto>())
            {
                if (!string.Equals(point.PointKind, "alarm", StringComparison.OrdinalIgnoreCase)) continue;
                if (PointBool(device, point)) return true;
            }
            return TokenBool(device?.Frame?["status"]?["alarm"]);
        }

        private static string DeviceState(DeviceView device)
        {
            if (HasAlarm(device)) return "报警";
            if (!IsOnline(device)) return "离线";
            if (IsRunning(device)) return "运行";
            return "待机";
        }

        private static Color DeviceStateColor(DeviceView device)
        {
            if (HasAlarm(device)) return Bad;
            if (!IsOnline(device)) return Warning;
            return IsRunning(device) ? Good : Accent;
        }

        private static Color PointQualityColor(DeviceView device, DataPointDto point)
        {
            var quality = PointQuality(device, point);
            if (string.Equals(quality, "good", StringComparison.OrdinalIgnoreCase)) return Good;
            if (string.Equals(quality, "stale", StringComparison.OrdinalIgnoreCase)) return Warning;
            return Bad;
        }

        private static string OverviewValue(DeviceView device)
        {
            var point = AnalogPoints(device.Device).FirstOrDefault(candidate => PointLabel(candidate).Contains("实际温度"))
                ?? AnalogPoints(device.Device).FirstOrDefault();
            return point == null ? DeviceState(device) : FormatPointValue(device, point);
        }

        private static void CountPointQuality(JObject frame, ref int good, ref int bad)
        {
            if (frame?["quality"] == null) return;
            foreach (var value in LeafValues(frame["quality"]))
            {
                var quality = value.ToString();
                if (string.Equals(quality, "good", StringComparison.OrdinalIgnoreCase)) good += 1;
                else if (!string.IsNullOrWhiteSpace(quality)) bad += 1;
            }
        }

        private static IEnumerable<JValue> LeafValues(JToken token)
        {
            if (token == null) yield break;
            if (token is JValue value)
            {
                yield return value;
                yield break;
            }
            foreach (var child in token.Children())
            {
                foreach (var leaf in LeafValues(child)) yield return leaf;
            }
        }

        private static string FriendlyState(string value)
        {
            if (string.IsNullOrWhiteSpace(value)) return "未知";
            var normalized = value.ToLowerInvariant();
            if (normalized.Contains("connected") || normalized.Contains("online") || normalized.Contains("running")) return "正常";
            if (normalized.Contains("simulat")) return "模拟";
            if (normalized.Contains("connect")) return "连接中";
            if (normalized.Contains("bad") || normalized.Contains("offline") || normalized.Contains("error")) return "异常";
            return value.Length > 8 ? value.Substring(0, 8) : value;
        }

        private static Color StateColor(string value)
        {
            if (string.IsNullOrWhiteSpace(value)) return Muted;
            var normalized = value.ToLowerInvariant();
            if (normalized.Contains("connected") || normalized.Contains("online") || normalized.Contains("running") || normalized.Contains("simulat")) return Good;
            if (normalized.Contains("connect") || normalized.Contains("retry")) return Warning;
            if (normalized.Contains("bad") || normalized.Contains("offline") || normalized.Contains("error")) return Bad;
            return Accent;
        }

        private static void WithOpacity(float opacity, Action draw)
        {
            var previous = GUI.color;
            GUI.color = new Color(previous.r, previous.g, previous.b, previous.a * Mathf.Clamp01(opacity));
            try
            {
                draw?.Invoke();
            }
            finally
            {
                GUI.color = previous;
            }
        }

        private void DrawPanel(Rect rect, string title, string subtitle)
        {
            DrawSolid(rect, Panel);
            DrawSolid(new Rect(rect.x, rect.y, rect.width, 2f), AccentSoft);
            GUI.Label(new Rect(rect.x + 18f, rect.y + 14f, rect.width - 36f, 26f), title, _sectionStyle);
            GUI.Label(new Rect(rect.x + 18f, rect.y + 39f, rect.width - 36f, 18f), subtitle, _smallStyle);
            DrawSolid(new Rect(rect.x + 18f, rect.y + 61f, rect.width - 36f, 1f), Border);
        }

        private void DrawMetricTile(Rect rect, string label, string value, Color color)
        {
            DrawSolid(rect, PanelStrong);
            DrawSolid(new Rect(rect.x, rect.y, 3f, rect.height), color);
            GUI.Label(new Rect(rect.x + 12f, rect.y + 10f, rect.width - 20f, 22f), label, _mutedStyle);
            LabelWithColor(new Rect(rect.x + 12f, rect.y + 34f, rect.width - 20f, 40f), value, _metricValueStyle, color);
        }

        private void DrawProgressRow(Rect rect, string label, float value, Color color)
        {
            value = Mathf.Clamp01(value);
            GUI.Label(new Rect(rect.x, rect.y, 96f, 20f), label, _bodyStyle);
            GUI.Label(new Rect(rect.x + rect.width - 54f, rect.y, 54f, 20f), $"{value * 100f:0}%", _smallStyle);
            DrawSolid(new Rect(rect.x, rect.y + 24f, rect.width, 6f), new Color(0.12f, 0.2f, 0.25f, 0.75f));
            DrawSolid(new Rect(rect.x, rect.y + 24f, rect.width * value, 6f), color);
        }

        private void DrawInfoRow(Rect rect, string label, string value)
        {
            GUI.Label(new Rect(rect.x, rect.y, 116f, rect.height), label, _mutedStyle);
            GUI.Label(new Rect(rect.x + 112f, rect.y, rect.width - 112f, rect.height), value ?? "--", _bodyStyle);
        }

        private void DrawStatusPill(Rect rect, string text, Color color)
        {
            DrawSolid(rect, new Color(color.r * 0.25f, color.g * 0.25f, color.b * 0.25f, 0.94f));
            DrawSolid(new Rect(rect.x, rect.y, 3f, rect.height), color);
            LabelWithColor(rect, text, _centerStyle, color);
        }

        private void DrawSolid(Rect rect, Color color)
        {
            if (_whiteTexture == null) return;
            var previous = GUI.color;
            color.a *= previous.a;
            GUI.color = color;
            GUI.DrawTexture(rect, _whiteTexture, ScaleMode.StretchToFill);
            GUI.color = previous;
        }

        private void DrawLine(Vector2 start, Vector2 end, Color color, float thickness)
        {
            var delta = end - start;
            if (delta.sqrMagnitude < 0.01f) return;
            var previousMatrix = GUI.matrix;
            var previousColor = GUI.color;
            var angle = Mathf.Atan2(delta.y, delta.x) * Mathf.Rad2Deg;
            GUIUtility.RotateAroundPivot(angle, start);
            color.a *= previousColor.a;
            GUI.color = color;
            GUI.DrawTexture(new Rect(start.x, start.y - thickness * 0.5f, delta.magnitude, thickness), _whiteTexture);
            GUI.matrix = previousMatrix;
            GUI.color = previousColor;
        }

        private static void LabelWithColor(Rect rect, string text, GUIStyle style, Color color)
        {
            var previous = style.normal.textColor;
            style.normal.textColor = color;
            GUI.Label(rect, text, style);
            style.normal.textColor = previous;
        }

        private void EnsureStyles()
        {
            if (_whiteTexture != null) return;
            _whiteTexture = new Texture2D(1, 1, TextureFormat.RGBA32, false) { name = "Dashboard Solid Texture" };
            _whiteTexture.SetPixel(0, 0, Color.white);
            _whiteTexture.Apply();
            _buttonTexture = CreateSolidTexture("Dashboard Button", PanelStrong);
            _buttonHoverTexture = CreateSolidTexture("Dashboard Button Hover", new Color(0.055f, 0.16f, 0.22f, 0.98f));
            _buttonActiveTexture = CreateSolidTexture("Dashboard Button Active", AccentSoft);
            _font = Font.CreateDynamicFontFromOSFont(
                new[] { "Microsoft YaHei UI", "Microsoft YaHei", "SimHei", "Arial" },
                18
            );

            _brandStyle = CreateStyle(24, FontStyle.Bold, Text, TextAnchor.UpperLeft);
            _headerStyle = CreateStyle(30, FontStyle.Bold, Text, TextAnchor.MiddleCenter);
            _sectionStyle = CreateStyle(18, FontStyle.Bold, Text, TextAnchor.MiddleLeft);
            _bodyStyle = CreateStyle(15, FontStyle.Normal, Text, TextAnchor.MiddleLeft);
            _mutedStyle = CreateStyle(13, FontStyle.Normal, Muted, TextAnchor.MiddleLeft);
            _smallStyle = CreateStyle(12, FontStyle.Normal, Muted, TextAnchor.MiddleCenter);
            _metricStyle = CreateStyle(17, FontStyle.Bold, Accent, TextAnchor.MiddleRight);
            _metricValueStyle = CreateStyle(30, FontStyle.Bold, Accent, TextAnchor.MiddleLeft);
            _centerStyle = CreateStyle(13, FontStyle.Normal, Text, TextAnchor.MiddleCenter);
            _buttonStyle = CreateStyle(15, FontStyle.Bold, Text, TextAnchor.MiddleCenter);
            _buttonStyle.normal.background = _buttonTexture;
            _buttonStyle.normal.textColor = Text;
            _buttonStyle.hover.background = _buttonHoverTexture;
            _buttonStyle.hover.textColor = Color.white;
            _buttonStyle.active.background = _buttonActiveTexture;
            _buttonStyle.active.textColor = Color.white;
            _buttonStyle.padding = new RectOffset(12, 12, 7, 7);
        }

        private static Texture2D CreateSolidTexture(string name, Color color)
        {
            var texture = new Texture2D(1, 1, TextureFormat.RGBA32, false) { name = name };
            texture.SetPixel(0, 0, color);
            texture.Apply();
            return texture;
        }

        private GUIStyle CreateStyle(int fontSize, FontStyle fontStyle, Color color, TextAnchor alignment)
        {
            return new GUIStyle(GUI.skin.label)
            {
                font = _font,
                fontSize = fontSize,
                fontStyle = fontStyle,
                alignment = alignment,
                clipping = TextClipping.Clip,
                wordWrap = false,
                normal = { textColor = color }
            };
        }

        private void OnDestroy()
        {
            if (_whiteTexture != null) Destroy(_whiteTexture);
            if (_buttonTexture != null) Destroy(_buttonTexture);
            if (_buttonHoverTexture != null) Destroy(_buttonHoverTexture);
            if (_buttonActiveTexture != null) Destroy(_buttonActiveTexture);
            if (_font != null) Destroy(_font);
        }
    }
}
