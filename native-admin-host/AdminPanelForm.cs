using System.Diagnostics;
using System.Drawing.Drawing2D;
using System.IO.Pipes;
using System.Text;
using System.Text.Json;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace HeatTreatmentAdminHost;

internal sealed class AdminPanelForm : Form
{
    private const int HeaderHeight = 46;
    private const int MinimumPanelWidth = 860;
    private const int MinimumPanelHeight = 560;
    private const int DragDetachDistance = 34;
    private const int ParentDockStripHeight = 92;
    private readonly HostOptions _options;
    private readonly WebView2 _webView = new();
    private readonly Panel _header = new();
    private readonly Label _title = new();
    private readonly Label _status = new();
    private readonly Button _maximizeButton = new();
    private readonly Button _closeButton = new();
    private readonly Panel _resizeGrip = new();
    private readonly System.Windows.Forms.Timer _parentTimer = new() { Interval = 250 };
    private readonly CancellationTokenSource _pipeCancellation = new();
    private DashboardChromeForm? _dashboardChrome;
    private readonly Rectangle _defaultDetachedBounds;
    private Rectangle _embeddedBounds;
    private Rectangle _savedDetachedBounds;
    private Rectangle _parentRestoreBounds;
    private bool _attached;
    private bool _adminVisible;
    private bool _parentMaximized;
    private bool _maximized;
    private bool _panelHidden;
    private bool _dragging;
    private bool _resizing;
    private bool _dockReady;
    private Point _dragStart;
    private Point _dragPointerOffset;
    private Rectangle _dragStartBounds;
    private IntPtr _parentHandle;
    private Task? _pipeTask;

    public AdminPanelForm(HostOptions options)
    {
        _options = options;
        _parentHandle = options.ParentWindowHandle;
        _defaultDetachedBounds = new Rectangle(120, 90, 1320, 820);
        _embeddedBounds = Rectangle.Empty;
        _savedDetachedBounds = _defaultDetachedBounds;
        _parentRestoreBounds = Rectangle.Empty;
        _attached = _parentHandle != IntPtr.Zero;
        _adminVisible = !options.StartInDashboardMode;

        Text = "后台管理";
        FormBorderStyle = FormBorderStyle.None;
        StartPosition = FormStartPosition.Manual;
        ShowInTaskbar = false;
        MinimizeBox = false;
        MaximizeBox = false;
        BackColor = Color.FromArgb(15, 23, 42);
        MinimumSize = new Size(MinimumPanelWidth, MinimumPanelHeight);
        ClientSize = _defaultDetachedBounds.Size;
        Location = _defaultDetachedBounds.Location;

        BuildChrome();
        _parentTimer.Tick += (_, _) => MaintainParentWindow();
        Shown += async (_, _) =>
        {
            _pipeTask = ListenForCommandsAsync(_pipeCancellation.Token);
            await InitializeWebViewAsync();
            BeginInvoke(ApplyInitialPlacement);
        };
        FormClosed += (_, _) => _pipeCancellation.Cancel();
    }

    private void BuildChrome()
    {
        _header.Dock = DockStyle.Top;
        _header.Height = 0;
        _header.Visible = false;
        _header.BackColor = Color.FromArgb(15, 31, 53);
        _header.Padding = new Padding(14, 0, 8, 0);
        _header.Cursor = Cursors.SizeAll;
        _header.MouseDown += BeginDrag;
        _header.MouseMove += ContinueDrag;
        _header.MouseUp += EndDrag;
        _header.DoubleClick += (_, _) => ToggleMaximize();

        _title.Text = "后台管理";
        _title.AutoSize = false;
        _title.Dock = DockStyle.Left;
        _title.Width = 250;
        _title.TextAlign = ContentAlignment.MiddleLeft;
        _title.ForeColor = Color.White;
        _title.Font = new Font("Microsoft YaHei UI", 11f, FontStyle.Bold);
        _title.Cursor = Cursors.SizeAll;
        _title.MouseDown += BeginDrag;
        _title.MouseMove += ContinueDrag;
        _title.MouseUp += EndDrag;

        _status.Text = "正在加载管理后台…";
        _status.AutoSize = true;
        _status.Dock = DockStyle.Left;
        _status.Padding = new Padding(8, 0, 0, 0);
        _status.TextAlign = ContentAlignment.MiddleLeft;
        _status.ForeColor = Color.FromArgb(161, 181, 201);
        _status.Font = new Font("Microsoft YaHei UI", 9f);

        ConfigureButton(_maximizeButton, "最大化", ToggleMaximize);
        ConfigureButton(_closeButton, "关闭", (_, _) => HidePanel());
        _closeButton.BackColor = Color.FromArgb(160, 54, 54);

        var buttons = new FlowLayoutPanel
        {
            Dock = DockStyle.Right,
            Width = 164,
            FlowDirection = FlowDirection.RightToLeft,
            WrapContents = false,
            Padding = new Padding(0, 7, 0, 7),
            BackColor = Color.Transparent
        };
        buttons.Controls.Add(_closeButton);
        buttons.Controls.Add(_maximizeButton);

        _header.Controls.Add(buttons);
        _header.Controls.Add(_status);
        _header.Controls.Add(_title);

        _webView.Dock = DockStyle.Fill;
        _webView.DefaultBackgroundColor = Color.FromArgb(246, 247, 249);
        _webView.Visible = false;

        _resizeGrip.Size = new Size(18, 18);
        _resizeGrip.Anchor = AnchorStyles.Right | AnchorStyles.Bottom;
        _resizeGrip.BackColor = Color.Transparent;
        _resizeGrip.Cursor = Cursors.SizeNWSE;
        _resizeGrip.Visible = false;
        _resizeGrip.Paint += (_, e) =>
        {
            using var pen = new Pen(Color.FromArgb(118, 143, 167), 1f);
            for (var offset = 4; offset <= 12; offset += 4)
            {
                e.Graphics.DrawLine(pen, _resizeGrip.Width - offset, _resizeGrip.Height - 2, _resizeGrip.Width - 2, _resizeGrip.Height - offset);
            }
        };
        _resizeGrip.MouseDown += BeginResize;
        _resizeGrip.MouseMove += ContinueResize;
        _resizeGrip.MouseUp += EndResize;

        Controls.Add(_webView);
        Controls.Add(_header);
        Controls.Add(_resizeGrip);
        _resizeGrip.BringToFront();
    }

    private static void ConfigureButton(Button button, string text, EventHandler click)
    {
        button.Text = text;
        button.Width = 72;
        button.Height = 30;
        button.Margin = new Padding(5, 0, 0, 0);
        button.FlatStyle = FlatStyle.Flat;
        button.FlatAppearance.BorderSize = 0;
        button.BackColor = Color.FromArgb(38, 70, 101);
        button.ForeColor = Color.White;
        button.Font = new Font("Microsoft YaHei UI", 9f);
        button.Cursor = Cursors.Hand;
        button.Click += click;
    }

    private async Task InitializeWebViewAsync()
    {
        try
        {
            var userData = _options.UserDataFolder;
            if (string.IsNullOrWhiteSpace(userData))
            {
                userData = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
                    "heat-treatment-digital-twin-desktop",
                    "webview2"
                );
            }
            Directory.CreateDirectory(userData);
            var fixedRuntime = Directory.Exists(_options.FixedRuntimeFolder)
                ? _options.FixedRuntimeFolder
                : null;
            var environment = await CoreWebView2Environment.CreateAsync(fixedRuntime, userData);
            await _webView.EnsureCoreWebView2Async(environment);
            _webView.CoreWebView2.Settings.AreDevToolsEnabled = true;
            _webView.CoreWebView2.Settings.IsStatusBarEnabled = false;
            _webView.CoreWebView2.Settings.AreDefaultContextMenusEnabled = true;
            _webView.CoreWebView2.NewWindowRequested += HandleNewWindow;
            _webView.CoreWebView2.DownloadStarting += HandleDownload;
            _webView.CoreWebView2.WebMessageReceived += HandleWebMessage;
            _webView.CoreWebView2.NavigationCompleted += (_, _) => SendHostState();
            _webView.CoreWebView2.Navigate(_options.Url);
            _webView.Visible = true;
            _status.Text = "已嵌入 Unity 大屏 · 可拖动后台管理页签";
        }
        catch (Exception exception)
        {
            _status.Text = "后台加载失败";
            var error = new Label
            {
                Dock = DockStyle.Fill,
                TextAlign = ContentAlignment.MiddleCenter,
                ForeColor = Color.FromArgb(120, 30, 30),
                BackColor = Color.FromArgb(250, 245, 245),
                Font = new Font("Microsoft YaHei UI", 11f),
                Text = $"无法加载内嵌后台。\n{exception.Message}\n\n请安装 Microsoft Edge WebView2 Runtime，或联系工程师检查日志。"
            };
            Controls.Add(error);
            error.BringToFront();
        }
    }

    private void HandleNewWindow(object? sender, CoreWebView2NewWindowRequestedEventArgs args)
    {
        args.Handled = true;
        _webView.CoreWebView2.Navigate(args.Uri);
    }

    private void HandleDownload(object? sender, CoreWebView2DownloadStartingEventArgs args)
    {
        using var dialog = new SaveFileDialog
        {
            Title = "保存后台导出文件",
            FileName = Path.GetFileName(args.ResultFilePath),
            Filter = "备份文件|*.zip;*.db|所有文件|*.*",
            RestoreDirectory = true
        };
        if (dialog.ShowDialog(this) == DialogResult.OK)
        {
            args.ResultFilePath = dialog.FileName;
            args.Handled = true;
        }
        else
        {
            args.Cancel = true;
            args.Handled = true;
        }
    }

    private void HandleWebMessage(object? sender, CoreWebView2WebMessageReceivedEventArgs args)
    {
        try
        {
            using var document = JsonDocument.Parse(args.WebMessageAsJson);
            var root = document.RootElement;
            if (!root.TryGetProperty("type", out var typeElement)) return;
            var type = typeElement.GetString();
            if (type == "close_admin")
            {
                HandleCloseRequest();
                return;
            }
            if (type == "host_action" && root.TryGetProperty("action", out var actionElement))
            {
                var action = actionElement.GetString();
                if (action == "attach" && !_attached) AttachToParent(true);
                else if (action == "detach" && _attached) DetachFromParent();
                else if (action == "toggle_attach") ToggleAttach();
                else if (action == "maximize") ToggleMaximize();
                else if (action == "show_dashboard") ShowDashboard();
                else if (action == "show_admin") ShowAdmin();
                else if (action == "close_window") HandleCloseRequest();
                else if (action == "close") HandleCloseRequest();
                else if (action == "state") SendHostState();
                SendHostState();
                return;
            }
            if (type == "host_drag_start")
            {
                BeginWebDrag(ReadCoordinate(root, "screenX"), ReadCoordinate(root, "screenY"));
                return;
            }
            if (type == "host_drag_move")
            {
                ContinueWebDrag(ReadCoordinate(root, "screenX"), ReadCoordinate(root, "screenY"));
                return;
            }
            if (type == "host_drag_end")
            {
                EndWebDrag(ReadCoordinate(root, "screenX"), ReadCoordinate(root, "screenY"));
            }
        }
        catch
        {
            // Messages from the page are advisory; malformed messages do not affect the host.
        }
    }

    private static int ReadCoordinate(JsonElement element, string key)
    {
        return element.TryGetProperty(key, out var value) && value.TryGetInt32(out var coordinate)
            ? coordinate
            : 0;
    }

    private void SendHostState()
    {
        if (!_webViewReadyForMessages()) return;
        try
        {
            _webView.CoreWebView2.PostWebMessageAsJson(JsonSerializer.Serialize(new
            {
                type = "host_state",
                attached = _attached,
                maximized = _attached ? _parentMaximized : _maximized,
                dockReady = _dockReady,
                adminVisible = _adminVisible
            }));
        }
        catch
        {
            // The page may be navigating; it will request state after the next navigation.
        }
    }

    private bool _webViewReadyForMessages()
    {
        return _webView.CoreWebView2 != null && !IsDisposed;
    }

    private void ApplyInitialPlacement()
    {
        if (TryResolveParentWindow())
        {
            InitializeParentWindowState();
            AttachToParent(false);
            _parentTimer.Start();
        }
        else
        {
            _attached = false;
            _adminVisible = true;
            Bounds = _defaultDetachedBounds;
            ShowPanel();
        }
    }

    private bool TryResolveParentWindow()
    {
        if (_parentHandle != IntPtr.Zero && NativeMethods.IsWindow(_parentHandle)) return true;
        if (_options.ParentProcessId <= 0) return false;
        try
        {
            using var process = Process.GetProcessById(_options.ParentProcessId);
            process.Refresh();
            if (process.MainWindowHandle != IntPtr.Zero)
            {
                _parentHandle = process.MainWindowHandle;
                return true;
            }
        }
        catch
        {
            // Parent may still be starting or may have exited.
        }
        return false;
    }

    private void MaintainParentWindow()
    {
        if (!TryResolveParentWindow())
        {
            Close();
            return;
        }
        if (!_attached)
        {
            _dashboardChrome?.UpdateParentBounds();
            return;
        }
        SetEmbeddedBounds(_adminVisible ? GetDefaultEmbeddedBounds() : GetDashboardChromeBounds());
    }

    private Size GetParentClientSize()
    {
        return NativeMethods.GetClientRect(_parentHandle, out var rect)
            ? new Size(Math.Max(1, rect.Width), Math.Max(1, rect.Height))
            : new Size(1600, 900);
    }

    private Rectangle GetParentClientScreenBounds()
    {
        var size = GetParentClientSize();
        var origin = new NativeMethods.Point { X = 0, Y = 0 };
        if (NativeMethods.ClientToScreen(_parentHandle, ref origin))
        {
            return new Rectangle(origin.X, origin.Y, size.Width, size.Height);
        }
        return NativeMethods.GetWindowRect(_parentHandle, out var rect)
            ? rect.ToRectangle()
            : Rectangle.Empty;
    }

    private bool IsParentDockPoint(int screenX, int screenY)
    {
        if (!TryResolveParentWindow()) return false;
        var parent = GetParentClientScreenBounds();
        if (parent == Rectangle.Empty) return false;
        var dockBottom = parent.Top + Math.Min(ParentDockStripHeight, parent.Height);
        return screenX >= parent.Left
            && screenX < parent.Right
            && screenY >= parent.Top - 8
            && screenY < dockBottom;
    }

    private void SetDockReady(bool value)
    {
        if (_dockReady == value) return;
        _dockReady = value;
        SendHostState();
    }

    private void InitializeParentWindowState()
    {
        if (!NativeMethods.GetWindowRect(_parentHandle, out var rect)) return;
        var current = rect.ToRectangle();
        var workingArea = Screen.FromHandle(_parentHandle).WorkingArea;
        _parentMaximized = RectanglesNearlyEqual(current, workingArea);
        _parentRestoreBounds = _parentMaximized ? GetDefaultParentRestoreBounds(workingArea) : current;
    }

    private static bool RectanglesNearlyEqual(Rectangle left, Rectangle right)
    {
        return Math.Abs(left.Left - right.Left) <= 3
            && Math.Abs(left.Top - right.Top) <= 3
            && Math.Abs(left.Width - right.Width) <= 6
            && Math.Abs(left.Height - right.Height) <= 6;
    }

    private static Rectangle GetDefaultParentRestoreBounds(Rectangle workingArea)
    {
        var width = Math.Min(workingArea.Width, Math.Min(1600, Math.Max(720, workingArea.Width - 120)));
        var height = Math.Min(workingArea.Height, Math.Min(900, Math.Max(520, workingArea.Height - 100)));
        return new Rectangle(
            workingArea.Left + Math.Max(0, (workingArea.Width - width) / 2),
            workingArea.Top + Math.Max(0, (workingArea.Height - height) / 2),
            width,
            height
        );
    }

    private void ToggleParentMaximize()
    {
        if (!TryResolveParentWindow()) return;
        var workingArea = Screen.FromHandle(_parentHandle).WorkingArea;
        if (!_parentMaximized)
        {
            if (NativeMethods.GetWindowRect(_parentHandle, out var rect)) _parentRestoreBounds = rect.ToRectangle();
            NativeMethods.SetWindowPos(
                _parentHandle,
                NativeMethods.HwndTop,
                workingArea.Left,
                workingArea.Top,
                workingArea.Width,
                workingArea.Height,
                NativeMethods.SwpFrameChanged | NativeMethods.SwpShowWindow
            );
            _parentMaximized = true;
        }
        else
        {
            var restore = _parentRestoreBounds.Width > 0
                ? _parentRestoreBounds
                : GetDefaultParentRestoreBounds(workingArea);
            NativeMethods.SetWindowPos(
                _parentHandle,
                NativeMethods.HwndTop,
                restore.Left,
                restore.Top,
                restore.Width,
                restore.Height,
                NativeMethods.SwpFrameChanged | NativeMethods.SwpShowWindow
            );
            _parentMaximized = false;
        }
        BeginInvoke(() => MaintainParentWindow());
        _dashboardChrome?.UpdateState(_parentMaximized);
        SendHostState();
    }

    private void ShowDashboard()
    {
        _adminVisible = false;
        if (!_attached)
        {
            AttachToParent(true);
        }
        MinimumSize = Size.Empty;
        SetEmbeddedBounds(GetDashboardChromeBounds());
        ShowPanel(false);
        SendHostState();
    }

    private void ShowAdmin()
    {
        _adminVisible = true;
        if (_attached)
        {
            MinimumSize = Size.Empty;
            SetEmbeddedBounds(GetDefaultEmbeddedBounds());
        }
        else
        {
            MinimumSize = new Size(MinimumPanelWidth, MinimumPanelHeight);
        }
        ShowPanel();
        SendHostState();
    }

    private void HandleCloseRequest()
    {
        if (_attached)
        {
            NativeMethods.PostMessage(_parentHandle, NativeMethods.WmClose, IntPtr.Zero, IntPtr.Zero);
            return;
        }
        ShowDashboard();
    }

    private void ShowDetachedDashboardChrome()
    {
        if (_attached || !TryResolveParentWindow()) return;
        if (_dashboardChrome == null || _dashboardChrome.IsDisposed)
        {
            _dashboardChrome = new DashboardChromeForm(HandleDashboardChromeAction);
        }
        _dashboardChrome.ShowForParent(_parentHandle, _parentMaximized);
    }

    private void HideDetachedDashboardChrome()
    {
        if (_dashboardChrome == null || _dashboardChrome.IsDisposed) return;
        NativeMethods.ShowWindow(_dashboardChrome.Handle, NativeMethods.SwHide);
        _dashboardChrome.Hide();
    }

    private void HandleDashboardChromeAction(string action, int screenX, int screenY)
    {
        switch (action)
        {
            case "focus_admin":
                ShowPanel();
                break;
            case "maximize":
                ToggleParentMaximize();
                break;
            case "close":
                NativeMethods.PostMessage(_parentHandle, NativeMethods.WmClose, IntPtr.Zero, IntPtr.Zero);
                break;
        }
    }

    private Rectangle GetDefaultEmbeddedBounds()
    {
        var client = GetParentClientSize();
        return new Rectangle(0, 0, client.Width, client.Height);
    }

    private Rectangle GetDashboardChromeBounds()
    {
        var client = GetParentClientSize();
        return new Rectangle(0, 0, client.Width, HeaderHeight);
    }

    private void AttachToParent(bool preserveScreenPosition)
    {
        if (!TryResolveParentWindow()) return;
        HideDetachedDashboardChrome();
        if (!_attached && preserveScreenPosition && NativeMethods.GetWindowRect(Handle, out var screenRect))
        {
            _savedDetachedBounds = screenRect.ToRectangle();
        }
        if (_embeddedBounds == Rectangle.Empty) _embeddedBounds = GetDefaultEmbeddedBounds();
        _attached = true;
        _maximized = false;
        _dockReady = false;
        MinimumSize = Size.Empty;
        var style = NativeMethods.GetWindowStyle(Handle, NativeMethods.GwlStyle);
        style &= ~(NativeMethods.WsPopup | NativeMethods.WsCaption | NativeMethods.WsThickFrame | NativeMethods.WsMinimizeBox | NativeMethods.WsMaximizeBox | NativeMethods.WsSysMenu);
        style |= NativeMethods.WsChild | NativeMethods.WsVisible | NativeMethods.WsClipChildren | NativeMethods.WsClipSiblings;
        NativeMethods.SetWindowStyle(Handle, NativeMethods.GwlStyle, style);
        var exStyle = NativeMethods.GetWindowStyle(Handle, NativeMethods.GwlExStyle);
        exStyle &= ~NativeMethods.WsExAppWindow;
        exStyle |= NativeMethods.WsExToolWindow;
        NativeMethods.SetWindowStyle(Handle, NativeMethods.GwlExStyle, exStyle);
        NativeMethods.SetParent(Handle, _parentHandle);
        SetEmbeddedBounds(_adminVisible ? GetDefaultEmbeddedBounds() : GetDashboardChromeBounds());
        ShowPanel(_adminVisible);
        SendHostState();
    }

    private void DetachFromParent(Rectangle? requestedBounds = null, bool activate = true)
    {
        var embeddedScreenBounds = Rectangle.Empty;
        if (_attached && NativeMethods.GetWindowRect(Handle, out var screenRect)) embeddedScreenBounds = screenRect.ToRectangle();
        _attached = false;
        _adminVisible = true;
        _maximized = false;
        _dockReady = false;
        MinimumSize = new Size(MinimumPanelWidth, MinimumPanelHeight);
        NativeMethods.SetParent(Handle, IntPtr.Zero);
        var style = NativeMethods.GetWindowStyle(Handle, NativeMethods.GwlStyle);
        style &= ~NativeMethods.WsChild;
        style |= NativeMethods.WsPopup | NativeMethods.WsVisible | NativeMethods.WsClipChildren | NativeMethods.WsClipSiblings;
        NativeMethods.SetWindowStyle(Handle, NativeMethods.GwlStyle, style);
        var exStyle = NativeMethods.GetWindowStyle(Handle, NativeMethods.GwlExStyle);
        exStyle &= ~NativeMethods.WsExToolWindow;
        exStyle |= NativeMethods.WsExAppWindow;
        NativeMethods.SetWindowStyle(Handle, NativeMethods.GwlExStyle, exStyle);
        var bounds = requestedBounds
            ?? (_savedDetachedBounds.Width >= MinimumPanelWidth
                ? _savedDetachedBounds
                : embeddedScreenBounds.Width >= MinimumPanelWidth
                    ? embeddedScreenBounds
                    : _defaultDetachedBounds);
        NativeMethods.SetWindowPos(Handle, NativeMethods.HwndTop, bounds.X, bounds.Y, bounds.Width, bounds.Height, NativeMethods.SwpFrameChanged | NativeMethods.SwpShowWindow);
        Bounds = bounds;
        _panelHidden = false;
        NativeMethods.ShowWindow(Handle, NativeMethods.SwShow);
        if (activate)
        {
            NativeMethods.SetForegroundWindow(Handle);
            _webView.Focus();
        }
        ShowDetachedDashboardChrome();
        SendHostState();
    }

    private void ToggleAttach(object? sender = null, EventArgs? e = null)
    {
        if (_attached) DetachFromParent();
        else AttachToParent(true);
    }

    private void ToggleMaximize(object? sender = null, EventArgs? e = null)
    {
        if (_attached)
        {
            ToggleParentMaximize();
            return;
        }
        if (!_maximized)
        {
            _savedDetachedBounds = Bounds;
            var screen = Screen.FromHandle(Handle).WorkingArea;
            Bounds = screen;
            _maximized = true;
        }
        else
        {
            _maximized = false;
            Bounds = _savedDetachedBounds.Width >= MinimumPanelWidth ? _savedDetachedBounds : _defaultDetachedBounds;
        }
        _maximizeButton.Text = _maximized ? "还原" : "最大化";
        SendHostState();
    }

    private void SetEmbeddedBounds(Rectangle bounds)
    {
        _embeddedBounds = bounds;
        ClampEmbeddedBounds();
        var flags = NativeMethods.SwpFrameChanged;
        if (!_panelHidden) flags |= NativeMethods.SwpShowWindow;
        NativeMethods.SetWindowPos(Handle, NativeMethods.HwndTop, _embeddedBounds.X, _embeddedBounds.Y, _embeddedBounds.Width, _embeddedBounds.Height, flags);
    }

    private void ClampEmbeddedBounds()
    {
        var client = GetVisibleParentClientSize();
        var minimumWidth = _adminVisible ? Math.Min(MinimumPanelWidth, client.Width) : 1;
        var minimumHeight = _adminVisible ? Math.Min(MinimumPanelHeight, client.Height) : HeaderHeight;
        var width = Math.Min(Math.Max(minimumWidth, _embeddedBounds.Width), client.Width);
        var height = Math.Min(Math.Max(minimumHeight, _embeddedBounds.Height), client.Height);
        var x = Math.Clamp(_embeddedBounds.X, 0, Math.Max(0, client.Width - width));
        var y = Math.Clamp(_embeddedBounds.Y, 0, Math.Max(0, client.Height - height));
        _embeddedBounds = new Rectangle(x, y, width, height);
    }

    /// <summary>
    /// The Unity parent can extend past the visible desktop (taskbar overlap, a
    /// restored window dragged partly off-screen, a monitor that was disconnected).
    /// Sizing the embedded panel to the raw client rect then pushes the bottom of the
    /// admin page off-screen permanently: the page believes it fits, so it never shows
    /// a scrollbar and the last cards can never be reached. Clamp to the part of the
    /// parent that is actually on a monitor's working area.
    /// </summary>
    private Size GetVisibleParentClientSize()
    {
        var client = GetParentClientSize();
        var screenBounds = GetParentClientScreenBounds();
        if (screenBounds == Rectangle.Empty) return client;

        var workingArea = Screen.FromRectangle(screenBounds).WorkingArea;
        var visible = Rectangle.Intersect(screenBounds, workingArea);
        if (visible.Width <= 0 || visible.Height <= 0) return client;

        return new Size(
            Math.Max(1, Math.Min(client.Width, visible.Width)),
            Math.Max(1, Math.Min(client.Height, visible.Height))
        );
    }

    private void ShowPanel(bool focus = true)
    {
        if (IsDisposed) return;
        _panelHidden = false;
        Show();
        NativeMethods.ShowWindow(Handle, NativeMethods.SwShow);
        if (focus)
        {
            NativeMethods.SetForegroundWindow(Handle);
            _webView.Focus();
        }
        SendHostState();
    }

    private void HidePanel()
    {
        _panelHidden = true;
        NativeMethods.ShowWindow(Handle, NativeMethods.SwHide);
        Hide();
    }

    private void BeginDrag(object? sender, MouseEventArgs e)
    {
        if (e.Button != MouseButtons.Left) return;
        var pointer = Cursor.Position;
        BeginWindowDrag(pointer.X, pointer.Y);
    }

    private void ContinueDrag(object? sender, MouseEventArgs e)
    {
        if (!_dragging || e.Button != MouseButtons.Left) return;
        var pointer = Cursor.Position;
        ContinueWindowDrag(pointer.X, pointer.Y);
    }

    private void EndDrag(object? sender, MouseEventArgs e)
    {
        var pointer = Cursor.Position;
        EndWindowDrag(pointer.X, pointer.Y);
    }

    private void BeginWebDrag(int screenX, int screenY)
    {
        BeginWindowDrag(screenX, screenY);
    }

    private void ContinueWebDrag(int screenX, int screenY)
    {
        ContinueWindowDrag(screenX, screenY);
    }

    private void EndWebDrag(int screenX, int screenY)
    {
        EndWindowDrag(screenX, screenY);
    }

    private void BeginWindowDrag(int screenX, int screenY)
    {
        ResolvePointerCoordinates(ref screenX, ref screenY);
        if (!_attached && _maximized) RestoreDetachedWindowForDrag(screenX, screenY);
        _dragging = true;
        _dragStart = new Point(screenX, screenY);
        _dragStartBounds = _attached ? _embeddedBounds : Bounds;
        if (NativeMethods.GetWindowRect(Handle, out var windowRect))
        {
            _dragPointerOffset = new Point(
                Math.Clamp(screenX - windowRect.Left, 0, Math.Max(0, windowRect.Width - 1)),
                Math.Clamp(screenY - windowRect.Top, 0, Math.Max(0, windowRect.Height - 1))
            );
        }
        else
        {
            _dragPointerOffset = new Point(Math.Max(0, screenX - Bounds.Left), Math.Max(0, screenY - Bounds.Top));
        }
        SetDockReady(false);
    }

    private void ContinueWindowDrag(int screenX, int screenY)
    {
        if (!_dragging) return;
        ResolvePointerCoordinates(ref screenX, ref screenY);
        if (_attached)
        {
            var deltaX = screenX - _dragStart.X;
            var deltaY = screenY - _dragStart.Y;
            if ((deltaX * deltaX) + (deltaY * deltaY) >= DragDetachDistance * DragDetachDistance)
            {
                DetachForDrag(screenX, screenY);
            }
            return;
        }

        Bounds = new Rectangle(
            screenX - _dragPointerOffset.X,
            screenY - _dragPointerOffset.Y,
            _dragStartBounds.Width,
            _dragStartBounds.Height
        );
        SetDockReady(IsParentDockPoint(screenX, screenY));
    }

    private void EndWindowDrag(int screenX, int screenY)
    {
        if (!_dragging) return;
        ResolvePointerCoordinates(ref screenX, ref screenY);
        _dragging = false;
        if (!_attached)
        {
            _savedDetachedBounds = Bounds;
            if (IsParentDockPoint(screenX, screenY))
            {
                AttachToParent(true);
                return;
            }
        }
        SetDockReady(false);
    }

    private void DetachForDrag(int screenX, int screenY)
    {
        var wasMaximized = _maximized;
        var wasDashboardMode = _attached && !_adminVisible;
        var sourceSize = NativeMethods.GetWindowRect(Handle, out var windowRect)
            ? new Size(windowRect.Width, windowRect.Height)
            : _embeddedBounds.Size;
        var workingArea = Screen.FromPoint(new Point(screenX, screenY)).WorkingArea;
        var fillsMainWindow = _attached
            && (sourceSize.Width >= workingArea.Width * 0.9f || sourceSize.Height >= workingArea.Height * 0.9f);
        if (wasMaximized || wasDashboardMode || fillsMainWindow)
        {
            sourceSize = _savedDetachedBounds.Width >= MinimumPanelWidth
                ? _savedDetachedBounds.Size
                : _defaultDetachedBounds.Size;
        }
        _adminVisible = true;
        var detachedSize = FitDetachedSize(sourceSize, screenX, screenY);
        var gripX = Math.Clamp(_dragPointerOffset.X, 48, Math.Max(48, detachedSize.Width - 48));
        var gripY = Math.Clamp(_dragPointerOffset.Y, 0, Math.Min(HeaderHeight - 1, detachedSize.Height - 1));
        var bounds = new Rectangle(screenX - gripX, screenY - gripY, detachedSize.Width, detachedSize.Height);
        DetachFromParent(bounds, false);
        _dragStart = new Point(screenX, screenY);
        _dragStartBounds = bounds;
        _dragPointerOffset = new Point(gripX, gripY);
    }

    private void RestoreDetachedWindowForDrag(int screenX, int screenY)
    {
        var maximizedBounds = Bounds;
        var requested = _savedDetachedBounds.Width >= MinimumPanelWidth
            ? _savedDetachedBounds.Size
            : _defaultDetachedBounds.Size;
        var restoredSize = FitDetachedSize(requested, screenX, screenY);
        var horizontalRatio = maximizedBounds.Width > 0
            ? Math.Clamp((screenX - maximizedBounds.Left) / (double)maximizedBounds.Width, 0.08d, 0.92d)
            : 0.5d;
        var gripX = (int)Math.Round(restoredSize.Width * horizontalRatio);
        var gripY = Math.Clamp(screenY - maximizedBounds.Top, 0, HeaderHeight - 1);
        _maximized = false;
        Bounds = new Rectangle(screenX - gripX, screenY - gripY, restoredSize.Width, restoredSize.Height);
        SendHostState();
    }

    private static void ResolvePointerCoordinates(ref int screenX, ref int screenY)
    {
        if (screenX != 0 || screenY != 0) return;
        if (!NativeMethods.GetCursorPos(out var pointer)) return;
        screenX = pointer.X;
        screenY = pointer.Y;
    }

    private static Size FitDetachedSize(Size requested, int screenX, int screenY)
    {
        var workingArea = Screen.FromPoint(new Point(screenX, screenY)).WorkingArea;
        var width = Math.Min(Math.Max(MinimumPanelWidth, requested.Width), Math.Max(MinimumPanelWidth, workingArea.Width));
        var height = Math.Min(Math.Max(MinimumPanelHeight, requested.Height), Math.Max(MinimumPanelHeight, workingArea.Height));
        return new Size(width, height);
    }

    private void BeginResize(object? sender, MouseEventArgs e)
    {
        if (e.Button != MouseButtons.Left) return;
        _resizing = true;
        _dragStart = Cursor.Position;
        _dragStartBounds = _attached ? _embeddedBounds : Bounds;
    }

    private void ContinueResize(object? sender, MouseEventArgs e)
    {
        if (!_resizing || e.Button != MouseButtons.Left) return;
        var current = Cursor.Position;
        var delta = new Size(current.X - _dragStart.X, current.Y - _dragStart.Y);
        var width = Math.Max(MinimumPanelWidth, _dragStartBounds.Width + delta.Width);
        var height = Math.Max(MinimumPanelHeight, _dragStartBounds.Height + delta.Height);
        if (_attached) SetEmbeddedBounds(new Rectangle(_dragStartBounds.X, _dragStartBounds.Y, width, height));
        else Bounds = new Rectangle(_dragStartBounds.X, _dragStartBounds.Y, width, height);
    }

    private void EndResize(object? sender, MouseEventArgs e) => _resizing = false;

    private async Task ListenForCommandsAsync(CancellationToken cancellationToken)
    {
        while (!cancellationToken.IsCancellationRequested)
        {
            try
            {
                await using var server = new NamedPipeServerStream(_options.PipeName, PipeDirection.In, 1, PipeTransmissionMode.Byte, PipeOptions.Asynchronous);
                await server.WaitForConnectionAsync(cancellationToken);
                using var reader = new StreamReader(server, Encoding.UTF8);
                var command = await reader.ReadLineAsync(cancellationToken);
                if (!string.IsNullOrWhiteSpace(command) && !IsDisposed)
                {
                    BeginInvoke(() =>
                    {
                        if (command.Equals("show", StringComparison.OrdinalIgnoreCase)) ShowAdmin();
                        else if (command.Equals("detach", StringComparison.OrdinalIgnoreCase) && _attached) DetachFromParent();
                        else if (command.Equals("attach", StringComparison.OrdinalIgnoreCase) && !_attached) AttachToParent(true);
                        else if (command.Equals("maximize", StringComparison.OrdinalIgnoreCase)) ToggleMaximize();
                        else if (command.Equals("close", StringComparison.OrdinalIgnoreCase)) Close();
                    });
                }
            }
            catch (OperationCanceledException) { break; }
            catch { await Task.Delay(200, cancellationToken); }
        }
    }

    protected override void OnFormClosing(FormClosingEventArgs e)
    {
        _parentTimer.Stop();
        _pipeCancellation.Cancel();
        if (_dashboardChrome != null && !_dashboardChrome.IsDisposed) _dashboardChrome.Close();
        base.OnFormClosing(e);
    }
}
