using System.Text.Json;
using System.Drawing.Drawing2D;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace HeatTreatmentAdminHost;

/// <summary>
/// Transparent WebView2 data layer rendered above the Unity client. The native
/// window region is reduced to the rectangles reported by Vue, so all empty
/// space remains genuine Unity input space instead of an invisible HTML window.
/// </summary>
internal sealed class DashboardOverlayForm : Form
{
    // Keep the native hit-test region tight. A windowed WebView2 paints its
    // transparent margins as an opaque strip on some Edge runtimes; expanding
    // the region beyond the actual widget would therefore create visible
    // rectangles over the Unity scene.
    private const int InteractionPadding = 0;
    private readonly HostOptions _options;
    private readonly WebView2 _webView = new();
    private readonly List<CssInteractionRegion> _cssRegions = new();
    private readonly List<AppliedInteractionRegion> _appliedRegions = new();
    private SizeF _cssViewport = new(1f, 1f);
    private IntPtr _parentHandle;
    private Region? _interactionRegion;
    private Size _lastParentClientSize = Size.Empty;
    private uint _lastDpi = 96;
    private bool _attached;
    private bool _initialized;
    private bool _visibleRequested;

    public DashboardOverlayForm(HostOptions options)
    {
        _options = options;
        Text = "数字孪生透明数据层";
        FormBorderStyle = FormBorderStyle.None;
        StartPosition = FormStartPosition.Manual;
        ShowInTaskbar = false;
        MinimizeBox = false;
        MaximizeBox = false;
        MinimumSize = Size.Empty;
        BackColor = Color.FromArgb(8, 18, 30);

        _webView.Dock = DockStyle.Fill;
        _webView.DefaultBackgroundColor = Color.Transparent;
        _webView.Visible = false;
        Controls.Add(_webView);

        ApplyEmptyInteractionRegion();
    }

    protected override bool ShowWithoutActivation => true;

    public async Task InitializeAsync(CoreWebView2Environment environment)
    {
        if (_initialized || IsDisposed) return;
        await _webView.EnsureCoreWebView2Async(environment);
        _webView.DefaultBackgroundColor = Color.Transparent;
        _webView.CoreWebView2.Settings.AreDevToolsEnabled = true;
        _webView.CoreWebView2.Settings.IsStatusBarEnabled = false;
        _webView.CoreWebView2.Settings.AreDefaultContextMenusEnabled = false;
        _webView.CoreWebView2.Settings.IsZoomControlEnabled = false;
        ApplyDpiCompensatedZoom();
        _webView.CoreWebView2.NewWindowRequested += (_, args) => args.Handled = true;
        _webView.CoreWebView2.WebMessageReceived += HandleWebMessage;
        _webView.CoreWebView2.NavigationCompleted += (_, args) =>
        {
            if (!args.IsSuccess)
            {
                WriteOverlayError($"透明数据层导航失败：{args.WebErrorStatus}");
                return;
            }
            PostHostState();
        };
        _webView.CoreWebView2.Navigate(BuildOverlayUrl(_options.Url));
        _webView.Visible = true;
        _initialized = true;
    }

    public void ShowForParent(IntPtr parentHandle)
    {
        if (IsDisposed || parentHandle == IntPtr.Zero || !NativeMethods.IsWindow(parentHandle)) return;
        _visibleRequested = true;
        AttachToParent(parentHandle);
        UpdateParentBounds(force: true);
        if (!Visible) Show();
        NativeMethods.ShowWindow(Handle, NativeMethods.SwShow);
        PostHostState();
    }

    public void HideOverlay()
    {
        if (IsDisposed) return;
        _visibleRequested = false;
        if (IsHandleCreated) NativeMethods.ShowWindow(Handle, NativeMethods.SwHide);
        Hide();
        PostHostState();
    }

    public void UpdateParentBounds(bool force = false)
    {
        if (!_attached || _parentHandle == IntPtr.Zero || !NativeMethods.IsWindow(_parentHandle)) return;
        if (!NativeMethods.GetClientRect(_parentHandle, out var client)) return;
        var clientSize = new Size(Math.Max(1, client.Width), Math.Max(1, client.Height));
        ApplyDpiCompensatedZoom();
        if (!force && clientSize == _lastParentClientSize) return;
        _lastParentClientSize = clientSize;

        var height = Math.Max(1, clientSize.Height - DashboardChromeForm.ChromeHeight);
        var flags = NativeMethods.SwpFrameChanged | NativeMethods.SwpNoActivate;
        if (_visibleRequested) flags |= NativeMethods.SwpShowWindow;
        NativeMethods.SetWindowPos(
            Handle,
            NativeMethods.HwndTop,
            0,
            DashboardChromeForm.ChromeHeight,
            clientSize.Width,
            height,
            flags
        );
        UpdateInteractionRegion();
        PostHostState();
    }

    /// <summary>
    /// The Unity player is rendered in physical pixels while this transparent
    /// WebView is authored in CSS pixels. WebView2 keeps the page at a 1.0
    /// zoom on a scaled monitor unless the host compensates for the monitor
    /// DPI, which makes the overlay visibly larger than the Unity viewport.
    /// Keep the effective physical size stable by applying the inverse scale.
    /// </summary>
    private void ApplyDpiCompensatedZoom()
    {
        if (_webView.CoreWebView2 == null || IsDisposed) return;
        var dpi = _parentHandle != IntPtr.Zero
            ? NativeMethods.GetDpiForWindow(_parentHandle)
            : (uint)Math.Max(96, DeviceDpi);
        if (dpi == 0) dpi = 96;
        var zoom = Math.Clamp(96d / dpi, 0.5d, 1d);
        if (_lastDpi == dpi && Math.Abs(_webView.ZoomFactor - zoom) < 0.005d) return;
        _lastDpi = dpi;
        try
        {
            _webView.ZoomFactor = zoom;
        }
        catch
        {
            // WebView2 may be between controller creation and navigation.
            // NavigationCompleted calls this method again through the next
            // bounds update, so a transient failure is harmless.
        }
    }

    private void AttachToParent(IntPtr parentHandle)
    {
        if (_attached && _parentHandle == parentHandle) return;
        _parentHandle = parentHandle;

        var style = NativeMethods.GetWindowStyle(Handle, NativeMethods.GwlStyle);
        style &= ~(NativeMethods.WsPopup
            | NativeMethods.WsCaption
            | NativeMethods.WsThickFrame
            | NativeMethods.WsMinimizeBox
            | NativeMethods.WsMaximizeBox
            | NativeMethods.WsSysMenu);
        style |= NativeMethods.WsChild
            | NativeMethods.WsVisible
            | NativeMethods.WsClipChildren
            | NativeMethods.WsClipSiblings;
        NativeMethods.SetWindowStyle(Handle, NativeMethods.GwlStyle, style);

        var exStyle = NativeMethods.GetWindowStyle(Handle, NativeMethods.GwlExStyle);
        exStyle &= ~NativeMethods.WsExAppWindow;
        exStyle |= NativeMethods.WsExToolWindow;
        NativeMethods.SetWindowStyle(Handle, NativeMethods.GwlExStyle, exStyle);
        NativeMethods.SetParent(Handle, _parentHandle);
        _attached = true;
        _lastParentClientSize = Size.Empty;
    }

    private void HandleWebMessage(object? sender, CoreWebView2WebMessageReceivedEventArgs args)
    {
        try
        {
            using var document = JsonDocument.Parse(args.WebMessageAsJson);
            var root = document.RootElement;
            if (!root.TryGetProperty("type", out var typeElement)) return;
            var type = typeElement.GetString();
            if (type == "overlay_ready")
            {
                PostHostState();
                return;
            }
            if (type == "overlay_regions") ReadInteractionRegions(root);
        }
        catch (Exception exception)
        {
            WriteOverlayError("透明数据层消息解析失败", exception);
        }
    }

    private void ReadInteractionRegions(JsonElement root)
    {
        var viewportWidth = 1f;
        var viewportHeight = 1f;
        if (root.TryGetProperty("viewport", out var viewport))
        {
            viewportWidth = ReadPositiveSingle(viewport, "width", 1f);
            viewportHeight = ReadPositiveSingle(viewport, "height", 1f);
        }

        _cssViewport = new SizeF(viewportWidth, viewportHeight);
        _cssRegions.Clear();
        if (root.TryGetProperty("regions", out var regions) && regions.ValueKind == JsonValueKind.Array)
        {
            foreach (var item in regions.EnumerateArray())
            {
                var x = ReadSingle(item, "x", 0f);
                var y = ReadSingle(item, "y", 0f);
                var width = ReadPositiveSingle(item, "width", 0f);
                var height = ReadPositiveSingle(item, "height", 0f);
                if (width < 1f || height < 1f) continue;
                var radius = Math.Max(0f, ReadSingle(item, "radius", 0f));
                _cssRegions.Add(new CssInteractionRegion(new RectangleF(x, y, width, height), radius));
            }
        }
        UpdateInteractionRegion();
    }

    private static float ReadSingle(JsonElement element, string name, float fallback)
    {
        if (!element.TryGetProperty(name, out var value) || !value.TryGetSingle(out var result)) return fallback;
        return float.IsFinite(result) ? result : fallback;
    }

    private static float ReadPositiveSingle(JsonElement element, string name, float fallback)
    {
        var value = ReadSingle(element, name, fallback);
        return value > 0f ? value : fallback;
    }

    private void UpdateInteractionRegion()
    {
        if (IsDisposed || ClientSize.Width < 1 || ClientSize.Height < 1)
        {
            return;
        }

        var scaleX = ClientSize.Width / Math.Max(1f, _cssViewport.Width);
        var scaleY = ClientSize.Height / Math.Max(1f, _cssViewport.Height);
        var clientBounds = new Rectangle(Point.Empty, ClientSize);
        var pixelRegions = new List<AppliedInteractionRegion>();
        foreach (var item in _cssRegions)
        {
            var left = (int)Math.Floor((item.Bounds.Left - InteractionPadding) * scaleX);
            var top = (int)Math.Floor((item.Bounds.Top - InteractionPadding) * scaleY);
            var right = (int)Math.Ceiling((item.Bounds.Right + InteractionPadding) * scaleX);
            var bottom = (int)Math.Ceiling((item.Bounds.Bottom + InteractionPadding) * scaleY);
            var clipped = Rectangle.Intersect(
                clientBounds,
                Rectangle.FromLTRB(left, top, right, bottom)
            );
            if (clipped.Width <= 0 || clipped.Height <= 0) continue;
            var radius = (int)Math.Round(item.Radius * Math.Min(scaleX, scaleY));
            radius = Math.Clamp(radius, 0, Math.Min(clipped.Width, clipped.Height) / 2);
            pixelRegions.Add(new AppliedInteractionRegion(clipped, radius));
        }

        if (_appliedRegions.SequenceEqual(pixelRegions)) return;
        _appliedRegions.Clear();
        _appliedRegions.AddRange(pixelRegions);

        var nextRegion = new Region();
        nextRegion.MakeEmpty();
        foreach (var item in pixelRegions)
        {
            if (item.Radius <= 1)
            {
                nextRegion.Union(item.Bounds);
                continue;
            }
            using var path = CreateRoundedRectanglePath(item.Bounds, item.Radius);
            nextRegion.Union(path);
        }
        if (pixelRegions.Count == 0) nextRegion.Union(new Rectangle(-4, -4, 1, 1));

        var previous = _interactionRegion;
        _interactionRegion = nextRegion;
        Region = nextRegion;
        previous?.Dispose();
    }

    private void ApplyEmptyInteractionRegion()
    {
        _cssRegions.Clear();
        _appliedRegions.Clear();
        var nextRegion = new Region(new Rectangle(-4, -4, 1, 1));
        var previous = _interactionRegion;
        _interactionRegion = nextRegion;
        Region = nextRegion;
        previous?.Dispose();
    }

    private static GraphicsPath CreateRoundedRectanglePath(Rectangle bounds, int radius)
    {
        var path = new GraphicsPath();
        var diameter = Math.Max(2, radius * 2);
        var arc = new Rectangle(bounds.X, bounds.Y, diameter, diameter);
        path.AddArc(arc, 180, 90);
        arc.X = bounds.Right - diameter;
        path.AddArc(arc, 270, 90);
        arc.Y = bounds.Bottom - diameter;
        path.AddArc(arc, 0, 90);
        arc.X = bounds.Left;
        path.AddArc(arc, 90, 90);
        path.CloseFigure();
        return path;
    }

    private void PostHostState()
    {
        if (!_initialized || _webView.CoreWebView2 == null || IsDisposed) return;
        try
        {
            _webView.CoreWebView2.PostWebMessageAsJson(JsonSerializer.Serialize(new
            {
                type = "overlay_host_state",
                visible = _visibleRequested,
                attached = _attached,
                width = ClientSize.Width,
                height = ClientSize.Height,
                dpi = _lastDpi,
                zoomFactor = _webView.ZoomFactor
            }));
        }
        catch
        {
            // The page can be between navigations; it reports its regions again after loading.
        }
    }

    private static string BuildOverlayUrl(string sourceUrl)
    {
        try
        {
            var source = new Uri(sourceUrl, UriKind.Absolute);
            var builder = new UriBuilder(source)
            {
                Path = "/overlay",
                Query = "embedded=unity&release=current"
            };
            return builder.Uri.AbsoluteUri;
        }
        catch
        {
            return "http://127.0.0.1:3001/overlay?embedded=unity&release=current";
        }
    }

    private static void WriteOverlayError(string message, Exception? exception = null)
    {
        try
        {
            var directory = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
                "heat-treatment-digital-twin-desktop",
                "logs"
            );
            Directory.CreateDirectory(directory);
            File.AppendAllText(
                Path.Combine(directory, "admin-host.log"),
                $"[{DateTimeOffset.Now:O}] {message}{(exception == null ? string.Empty : $": {exception}")}\n"
            );
        }
        catch
        {
            // Overlay diagnostics must not affect the dashboard.
        }
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            _interactionRegion?.Dispose();
            _interactionRegion = null;
            _webView.Dispose();
        }
        base.Dispose(disposing);
    }

    private readonly record struct CssInteractionRegion(RectangleF Bounds, float Radius);
    private readonly record struct AppliedInteractionRegion(Rectangle Bounds, int Radius);
}
