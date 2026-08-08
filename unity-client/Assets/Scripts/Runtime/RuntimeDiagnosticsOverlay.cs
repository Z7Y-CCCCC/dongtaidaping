using System;
using HeatTreatment.DigitalTwin.Rendering;
using UnityEngine;

namespace HeatTreatment.DigitalTwin.Runtime
{
    public sealed class RuntimeDiagnosticsOverlay : MonoBehaviour
    {
        private GUIStyle _titleStyle;
        private GUIStyle _lineStyle;
        private GUIStyle _mutedStyle;
        private Texture2D _panelTexture;
        private Texture2D _loadingTexture;
        private float _smoothedFps;
        private long _lastFrameTimestamp;
        private int _lastFrameDevices;
        private bool _loadingVisible;
        private float _loadingProgress;
        private string _loadingStep = "正在初始化渲染";

        public bool Visible { get; set; } = true;
        public string BackendState { get; set; } = "starting";
        public string PlcState { get; set; } = "unknown";
        public string Activity { get; set; } = "Initializing native renderer";
        public int DeviceCount { get; set; }
        public int ReadyDeviceCount { get; set; }
        public int FallbackDeviceCount { get; set; }
        public int TemplateCount { get; set; }
        public NativeQualityController QualityController { get; set; }

        public void BeginLoading()
        {
            _loadingVisible = true;
            _loadingProgress = 0f;
            _loadingStep = "正在初始化渲染";
        }

        public void UpdateLoading(float progress, string step)
        {
            _loadingVisible = true;
            _loadingProgress = Mathf.Clamp01(progress);
            if (!string.IsNullOrWhiteSpace(step)) _loadingStep = step;
        }

        public void CompleteLoading()
        {
            _loadingProgress = 1f;
            _loadingStep = "场景已就绪";
            _loadingVisible = false;
        }

        public void RecordRealtimeFrame(long timestamp, int deviceCount)
        {
            _lastFrameTimestamp = timestamp;
            _lastFrameDevices = deviceCount;
        }

        private void Update()
        {
            var current = 1f / Mathf.Max(0.0001f, Time.unscaledDeltaTime);
            _smoothedFps = _smoothedFps <= 0f ? current : Mathf.Lerp(_smoothedFps, current, 0.08f);
            if (Input.GetKeyDown(KeyCode.F9)) Visible = !Visible;
        }

        private void OnGUI()
        {
            if (_loadingVisible)
            {
                DrawLoadingScreen();
                return;
            }
            if (!Visible) return;
            EnsureStyles();
            var scale = Mathf.Clamp(Screen.height / 1080f, 0.78f, 1.25f);
            GUI.matrix = Matrix4x4.Scale(new Vector3(scale, scale, 1f));
            var width = 410f;
            var height = 224f;
            GUI.DrawTexture(new Rect(18f, 18f, width, height), _panelTexture, ScaleMode.StretchToFill);
            GUI.Label(new Rect(36f, 31f, width - 36f, 28f), "NATIVE DIGITAL TWIN", _titleStyle);
            GUI.Label(new Rect(36f, 66f, width - 36f, 22f), $"FPS  {_smoothedFps:0}    GPU  {SystemInfo.graphicsDeviceName}", _lineStyle);
            GUI.Label(new Rect(36f, 91f, width - 36f, 22f), $"Backend  {BackendState}    PLC  {PlcState}", _lineStyle);
            GUI.Label(new Rect(36f, 116f, width - 36f, 22f), $"Devices  {ReadyDeviceCount}/{DeviceCount}    fallback  {FallbackDeviceCount}    templates  {TemplateCount}", _lineStyle);
            GUI.Label(new Rect(36f, 141f, width - 36f, 22f), FrameText(), _lineStyle);
            GUI.Label(new Rect(36f, 166f, width - 36f, 22f), $"Quality  {QualityController?.ActiveProfileName ?? "pending"} (full geometry)", _lineStyle);
            GUI.Label(new Rect(36f, 193f, width - 36f, 20f), Activity, _mutedStyle);
            GUI.Label(new Rect(36f, 217f, width - 36f, 18f), "F1/F2/F3 quality   F4 auto   F5 reload   Home frame   F9 hide", _mutedStyle);
        }

        private void DrawLoadingScreen()
        {
            EnsureStyles();
            if (_loadingTexture == null)
            {
                _loadingTexture = new Texture2D(1, 1, TextureFormat.RGBA32, false);
                _loadingTexture.SetPixel(0, 0, new Color(0.018f, 0.024f, 0.032f, 1f));
                _loadingTexture.Apply();
            }
            GUI.DrawTexture(new Rect(0f, 0f, Screen.width, Screen.height), _loadingTexture, ScaleMode.StretchToFill);
            var scale = Mathf.Clamp(Screen.height / 1080f, 0.8f, 1.35f);
            var center = new Vector2(Screen.width * .5f, Screen.height * .5f);
            var title = new GUIStyle(_titleStyle) { alignment = TextAnchor.MiddleCenter, fontSize = Mathf.RoundToInt(28f * scale) };
            var step = new GUIStyle(_lineStyle) { alignment = TextAnchor.MiddleCenter, fontSize = Mathf.RoundToInt(15f * scale) };
            GUI.Label(new Rect(0f, center.y - 92f * scale, Screen.width, 42f * scale), "正在启动数字孪生大屏", title);
            GUI.Label(new Rect(0f, center.y - 42f * scale, Screen.width, 30f * scale), _loadingStep, step);
            var barWidth = Mathf.Min(620f * scale, Screen.width * .72f);
            var bar = new Rect(center.x - barWidth * .5f, center.y + 12f * scale, barWidth, 8f * scale);
            GUI.color = new Color(.18f, .22f, .27f, 1f);
            GUI.DrawTexture(bar, _panelTexture, ScaleMode.StretchToFill);
            GUI.color = new Color(.25f, .75f, .96f, 1f);
            GUI.DrawTexture(new Rect(bar.x, bar.y, bar.width * _loadingProgress, bar.height), _panelTexture, ScaleMode.StretchToFill);
            GUI.color = Color.white;
            var percent = new GUIStyle(_mutedStyle) { alignment = TextAnchor.MiddleCenter, fontSize = Mathf.RoundToInt(12f * scale) };
            GUI.Label(new Rect(0f, bar.y + 18f * scale, Screen.width, 24f * scale), $"{Mathf.RoundToInt(_loadingProgress * 100f)}%", percent);
        }

        private string FrameText()
        {
            if (_lastFrameTimestamp <= 0) return "Realtime  waiting for first frame";
            var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            var age = Mathf.Max(0f, (now - _lastFrameTimestamp) / 1000f);
            return $"Realtime  {_lastFrameDevices} devices    frame age  {age:0.00}s";
        }

        private void EnsureStyles()
        {
            if (_panelTexture != null) return;
            _panelTexture = new Texture2D(1, 1, TextureFormat.RGBA32, false);
            _panelTexture.SetPixel(0, 0, new Color(0.025f, 0.045f, 0.06f, 0.91f));
            _panelTexture.Apply();
            _titleStyle = new GUIStyle(GUI.skin.label)
            {
                fontSize = 19,
                fontStyle = FontStyle.Bold,
                normal = { textColor = new Color(0.39f, 0.88f, 1f) }
            };
            _lineStyle = new GUIStyle(GUI.skin.label)
            {
                fontSize = 14,
                normal = { textColor = new Color(0.88f, 0.94f, 0.97f) }
            };
            _mutedStyle = new GUIStyle(GUI.skin.label)
            {
                fontSize = 12,
                normal = { textColor = new Color(0.55f, 0.68f, 0.74f) }
            };
        }
    }
}
