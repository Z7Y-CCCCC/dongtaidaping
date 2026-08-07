using System.Diagnostics;
using System.IO.Pipes;
using System.Net.Http;
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
    private const int WindowMoveStartDistance = 5;
    private const int ParentDockStripHeight = 92;
    private const int ResizeBorderThickness = 8;
    private const int RoundedCornerRadius = 12;
    private static readonly HttpClient DesktopControlClient = new() { Timeout = TimeSpan.FromSeconds(3) };
    private readonly HostOptions _options;
    private readonly WebView2 _webView = new();
    private readonly Panel _header = new();
    private readonly Label _title = new();
    private readonly Label _status = new();
    private readonly Button _maximizeButton = new();
    private readonly Button _closeButton = new();
    private readonly Panel _resizeGrip = new();
    private readonly System.Windows.Forms.Timer _parentTimer = new() { Interval = 33 };
    private readonly CancellationTokenSource _pipeCancellation = new();
    private DashboardChromeForm? _dashboardChrome;
    private DashboardOverlayForm? _dashboardOverlay;
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
    private bool _draggingParentWindow;
    private bool _parentDragStarted;
    private bool _nativeDetachedMovePending;
    private bool _resizing;
    private bool _dockReady;
    private bool _closeChoiceOpen;
    private Point _dragStart;
    private Point _dragPointerOffset;
    private Rectangle _dragStartBounds;
    private IntPtr _parentHandle;
    private readonly DateTime? _parentProcessStartTimeUtc;
    private bool _waitingForParentWindow;
    private Task? _pipeTask;

    public AdminPanelForm(HostOptions options)
    {
        _options = options;
        _parentHandle = options.ParentWindowHandle;
        _parentProcessStartTimeUtc = ReadProcessStartTimeUtc(options.ParentProcessId);
        _defaultDetachedBounds = new Rectangle(120, 90, 1320, 820);
        _embeddedBounds = Rectangle.Empty;
        _savedDetachedBounds = _defaultDetachedBounds;
        _parentRestoreBounds = Rectangle.Empty;
        _attached = _parentHandle != IntPtr.Zero;
        _adminVisible = !options.StartInDashboardMode;

        Text = "后台管理";
        FormBorderStyle = FormBorderStyle.None;
        AutoScaleMode = AutoScaleMode.Dpi;
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
        FormClosed += (_, _) =>
        {
            _parentTimer.Stop();
            _pipeCancellation.Cancel();
        };
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
            try
            {
                _dashboardOverlay = new DashboardOverlayForm(_options);
                await _dashboardOverlay.InitializeAsync(environment);
            }
            catch (Exception overlayException)
            {
                WriteHostError("透明 WebView2 数据层初始化失败", overlayException);
                _dashboardOverlay?.Dispose();
                _dashboardOverlay = null;
            }
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
                else if (action == "minimize") MinimizeActiveWindow();
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
                var target = root.TryGetProperty("target", out var targetElement)
                    ? targetElement.GetString() ?? "admin"
                    : "admin";
                BeginWebDrag(ReadCoordinate(root, "screenX"), ReadCoordinate(root, "screenY"), target);
                return;
            }
            if (type == "host_window_move_start")
            {
                BeginNativeParentWindowMove(ReadCoordinate(root, "screenX"), ReadCoordinate(root, "screenY"));
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
            _waitingForParentWindow = false;
            _parentTimer.Interval = 33;
            InitializeParentWindowState();
            AttachToParent(false);
        }
        else
        {
            _attached = false;
            _adminVisible = true;
            _waitingForParentWindow = _options.ParentProcessId > 0;
            _parentTimer.Interval = 500;
            Bounds = _defaultDetachedBounds;
            ShowPanel();
        }
        if (_options.ParentProcessId > 0) _parentTimer.Start();
    }

    private static DateTime? ReadProcessStartTimeUtc(int processId)
    {
        if (processId <= 0) return null;
        try
        {
            using var process = Process.GetProcessById(processId);
            if (process.HasExited) return null;
            return process.StartTime.ToUniversalTime();
        }
        catch
        {
            return null;
        }
    }

    private bool IsParentProcessRunning()
    {
        var currentStartTime = ReadProcessStartTimeUtc(_options.ParentProcessId);
        if (!currentStartTime.HasValue) return false;
        return !_parentProcessStartTimeUtc.HasValue
            || currentStartTime.Value == _parentProcessStartTimeUtc.Value;
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
        if (!IsParentProcessRunning())
        {
            Close();
            return;
        }
        if (!TryResolveParentWindow())
        {
            // Unity can take several seconds to create its main HWND (and smoke/
            // batch mode may never create one).  Keep monitoring the process at a
            // low rate instead of becoming an orphan or closing during startup.
            _waitingForParentWindow = true;
            _parentTimer.Interval = 500;
            return;
        }
        if (_waitingForParentWindow)
        {
            _waitingForParentWindow = false;
            _parentTimer.Interval = 33;
            InitializeParentWindowState();
            AttachToParent(false);
            return;
        }
        RefreshParentWindowState();
        _dashboardOverlay?.UpdateParentBounds();
        if (!_attached)
        {
            _dashboardChrome?.UpdateParentBounds();
            SyncDashboardOverlay();
            return;
        }
        SetEmbeddedBounds(_adminVisible ? GetDefaultEmbeddedBounds() : GetDashboardChromeBounds());
        SyncDashboardOverlay();
    }

    private void RefreshParentWindowState()
    {
        if (_parentHandle == IntPtr.Zero || NativeMethods.IsIconic(_parentHandle)) return;
        if (!NativeMethods.GetWindowRect(_parentHandle, out var rect)) return;
        var current = rect.ToRectangle();
        if (current.Width <= 0 || current.Height <= 0) return;
        var workingArea = Screen.FromHandle(_parentHandle).WorkingArea;
        var maximized = RectanglesNearlyEqual(current, workingArea);
        if (!maximized) _parentRestoreBounds = current;
        if (_parentMaximized == maximized) return;
        _parentMaximized = maximized;
        _dashboardChrome?.UpdateState(maximized);
        SendHostState();
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
        var dockStripHeight = NativeMethods.Scale96(
            ParentDockStripHeight,
            NativeMethods.GetWindowDpiOrDefault(_parentHandle)
        );
        var dockBottom = parent.Top + Math.Min(dockStripHeight, parent.Height);
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
        SyncDashboardOverlay();
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
        SyncDashboardOverlay();
        SendHostState();
    }

    private void SyncDashboardOverlay()
    {
        if (_dashboardOverlay == null || _dashboardOverlay.IsDisposed) return;
        if (!TryResolveParentWindow())
        {
            _dashboardOverlay.HideOverlay();
            return;
        }

        var dashboardExposed = !_attached || !_adminVisible || _panelHidden;
        if (dashboardExposed)
        {
            _dashboardOverlay.ShowForParent(_parentHandle);
        }
        else
        {
            _dashboardOverlay.HideOverlay();
        }
    }

    private async void HandleCloseRequest()
    {
        if (_closeChoiceOpen) return;
        _closeChoiceOpen = true;
        try
        {
            var choice = ShowCloseChoiceDialog();
            if (choice == CloseChoice.MinimizeToTray)
            {
                await MinimizeToTrayAsync();
            }
            else if (choice == CloseChoice.ExitApplication)
            {
                await ExitApplicationAsync();
            }
        }
        catch (Exception exception)
        {
            WriteHostError("关闭选择弹窗创建失败", exception);
            try
            {
                MessageBox.Show(
                    this,
                    "关闭选项暂时无法显示，请重试。主程序仍在运行。",
                    "关闭操作",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Warning
                );
            }
            catch
            {
                // A UI fallback must never terminate the host process.
            }
        }
        finally
        {
            _closeChoiceOpen = false;
        }
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
            case "move_parent_native":
                BeginNativeParentWindowMove(screenX, screenY);
                break;
            case "move_parent_start":
                BeginParentWindowDrag(screenX, screenY);
                break;
            case "move_parent_move":
                ContinueWindowDrag(screenX, screenY);
                break;
            case "move_parent_end":
                EndWindowDrag(screenX, screenY);
                break;
            case "minimize":
                MinimizeActiveWindow();
                break;
            case "maximize":
                ToggleParentMaximize();
                break;
            case "close":
                HandleCloseRequest();
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
        return new Rectangle(0, 0, client.Width, GetParentChromeHeightPixels());
    }

    private int GetParentChromeHeightPixels()
    {
        return DashboardChromeForm.GetChromeHeightPixels(_parentHandle);
    }

    private int GetCurrentChromeHeightPixels()
    {
        return _attached
            ? GetParentChromeHeightPixels()
            : NativeMethods.Scale96(HeaderHeight, (uint)Math.Max(96, DeviceDpi));
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
        UpdateDetachedWindowAppearance();
        SetEmbeddedBounds(_adminVisible ? GetDefaultEmbeddedBounds() : GetDashboardChromeBounds(), force: true);
        ShowPanel(_adminVisible);
        SyncDashboardOverlay();
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
        style |= NativeMethods.WsPopup
            | NativeMethods.WsVisible
            | NativeMethods.WsClipChildren
            | NativeMethods.WsClipSiblings
            | NativeMethods.WsThickFrame
            | NativeMethods.WsMinimizeBox
            | NativeMethods.WsMaximizeBox
            | NativeMethods.WsSysMenu;
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
        UpdateDetachedWindowAppearance();
        _panelHidden = false;
        NativeMethods.ShowWindow(Handle, NativeMethods.SwShow);
        if (activate)
        {
            NativeMethods.SetForegroundWindow(Handle);
            _webView.Focus();
        }
        ShowDetachedDashboardChrome();
        SyncDashboardOverlay();
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
        UpdateDetachedWindowAppearance();
        SendHostState();
    }

    private void MinimizeActiveWindow()
    {
        if (_attached)
        {
            if (TryResolveParentWindow()) NativeMethods.ShowWindow(_parentHandle, NativeMethods.SwMinimize);
            return;
        }

        if (!_maximized) _savedDetachedBounds = Bounds;
        NativeMethods.ShowWindow(Handle, NativeMethods.SwMinimize);
    }

    private CloseChoice ShowCloseChoiceDialog()
    {
        using var dialog = new CloseChoiceDialog();
        IWin32Window owner = _attached && _parentHandle != IntPtr.Zero
            ? new WindowHandleOwner(_parentHandle)
            : this;
        dialog.ShowDialog(owner);
        return dialog.Choice;
    }

    private async Task MinimizeToTrayAsync()
    {
        if (!HasDesktopControl)
        {
            MinimizeActiveWindow();
            return;
        }

        if (await PostDesktopControlAsync("minimize-to-tray"))
        {
            HideApplicationToTray();
            return;
        }

        MessageBox.Show(
            this,
            "暂时无法连接桌面托盘服务，窗口将改为最小化到任务栏。",
            "托盘服务不可用",
            MessageBoxButtons.OK,
            MessageBoxIcon.Warning
        );
        MinimizeActiveWindow();
    }

    private async Task ExitApplicationAsync()
    {
        if (HasDesktopControl)
        {
            if (await PostDesktopControlAsync("quit")) return;
            MessageBox.Show(
                this,
                "无法连接桌面管理服务。为避免绕过退出备份，本次没有强制结束程序；请稍后重试或从右下角托盘菜单退出。",
                "安全退出失败",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error
            );
            return;
        }

        if (TryResolveParentWindow())
        {
            NativeMethods.PostMessage(_parentHandle, NativeMethods.WmClose, IntPtr.Zero, IntPtr.Zero);
        }
        else
        {
            Close();
        }
    }

    private bool HasDesktopControl => !string.IsNullOrWhiteSpace(_options.DesktopControlUrl)
        && !string.IsNullOrWhiteSpace(_options.DesktopControlToken);

    private static void WriteHostError(string message, Exception exception)
    {
        try
        {
            var logDirectory = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
                "heat-treatment-digital-twin-desktop",
                "logs"
            );
            Directory.CreateDirectory(logDirectory);
            File.AppendAllText(
                Path.Combine(logDirectory, "admin-host.log"),
                $"[{DateTimeOffset.Now:O}] {message}: {exception}\n"
            );
        }
        catch
        {
            // Diagnostics must not affect the UI host.
        }
    }

    private async Task<bool> PostDesktopControlAsync(string action)
    {
        if (!HasDesktopControl) return false;
        try
        {
            using var request = new HttpRequestMessage(
                HttpMethod.Post,
                $"{_options.DesktopControlUrl!.TrimEnd('/')}/{action}"
            );
            request.Headers.TryAddWithoutValidation("x-desktop-control-token", _options.DesktopControlToken);
            using var response = await DesktopControlClient.SendAsync(request);
            return response.IsSuccessStatusCode;
        }
        catch
        {
            return false;
        }
    }

    private void HideApplicationToTray()
    {
        _panelHidden = true;
        HideDetachedDashboardChrome();
        _dashboardOverlay?.HideOverlay();
        NativeMethods.ShowWindow(Handle, NativeMethods.SwHide);
        Hide();
        if (TryResolveParentWindow()) NativeMethods.ShowWindow(_parentHandle, NativeMethods.SwHide);
    }

    private void RestoreDashboardFromTray()
    {
        if (!TryResolveParentWindow()) return;
        NativeMethods.ShowWindow(_parentHandle, NativeMethods.SwRestore);
        NativeMethods.ShowWindow(_parentHandle, NativeMethods.SwShow);
        ShowDashboard();
        SyncDashboardOverlay();
        NativeMethods.SetForegroundWindow(_parentHandle);
    }

    private void SetEmbeddedBounds(Rectangle bounds, bool force = false)
    {
        var previous = _embeddedBounds;
        _embeddedBounds = bounds;
        ClampEmbeddedBounds();
        if (!force && previous == _embeddedBounds) return;
        var flags = NativeMethods.SwpFrameChanged;
        if (!_panelHidden) flags |= NativeMethods.SwpShowWindow;
        NativeMethods.SetWindowPos(Handle, NativeMethods.HwndTop, _embeddedBounds.X, _embeddedBounds.Y, _embeddedBounds.Width, _embeddedBounds.Height, flags);
    }

    private void ClampEmbeddedBounds()
    {
        // An embedded child must always use the complete Unity client area.
        // Windows clips the part that is outside the monitor naturally. Using
        // the visible monitor intersection here makes the child narrower than
        // its parent whenever the borderless Unity window is moved partly off
        // screen, leaving an exposed strip of the Unity background on the
        // right/bottom (the top-bar gap seen in the field screenshot).
        var client = GetParentClientSize();
        var minimumWidth = _adminVisible ? Math.Min(MinimumPanelWidth, client.Width) : 1;
        var minimumHeight = _adminVisible
            ? Math.Min(MinimumPanelHeight, client.Height)
            : (_attached ? GetParentChromeHeightPixels() : HeaderHeight);
        var width = Math.Min(Math.Max(minimumWidth, _embeddedBounds.Width), client.Width);
        var height = Math.Min(Math.Max(minimumHeight, _embeddedBounds.Height), client.Height);
        var x = Math.Clamp(_embeddedBounds.X, 0, Math.Max(0, client.Width - width));
        var y = Math.Clamp(_embeddedBounds.Y, 0, Math.Max(0, client.Height - height));
        _embeddedBounds = new Rectangle(x, y, width, height);
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
        SyncDashboardOverlay();
        SendHostState();
    }

    private void HidePanel()
    {
        _panelHidden = true;
        NativeMethods.ShowWindow(Handle, NativeMethods.SwHide);
        Hide();
        SyncDashboardOverlay();
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

    private void BeginWebDrag(int screenX, int screenY, string target)
    {
        BeginWindowDrag(screenX, screenY, target);
    }

    private void ContinueWebDrag(int screenX, int screenY)
    {
        ContinueWindowDrag(screenX, screenY);
    }

    private void EndWebDrag(int screenX, int screenY)
    {
        EndWindowDrag(screenX, screenY);
    }

    private void BeginWindowDrag(int screenX, int screenY, string target = "admin")
    {
        ResolvePointerCoordinates(ref screenX, ref screenY);
        _draggingParentWindow = false;
        if (_attached && target.Equals("dashboard", StringComparison.OrdinalIgnoreCase))
        {
            BeginNativeParentWindowMove(screenX, screenY);
            return;
        }
        if (!_attached)
        {
            BeginNativeDetachedWindowMove(screenX, screenY);
            return;
        }
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
        if (_draggingParentWindow)
        {
            if (!_parentDragStarted)
            {
                var deltaX = screenX - _dragStart.X;
                var deltaY = screenY - _dragStart.Y;
                if ((deltaX * deltaX) + (deltaY * deltaY) < WindowMoveStartDistance * WindowMoveStartDistance)
                {
                    return;
                }
                StartParentWindowMove(screenX, screenY);
            }
            var bounds = new Rectangle(
                screenX - _dragPointerOffset.X,
                screenY - _dragPointerOffset.Y,
                _dragStartBounds.Width,
                _dragStartBounds.Height
            );
            NativeMethods.SetWindowPos(
                _parentHandle,
                NativeMethods.HwndTop,
                bounds.X,
                bounds.Y,
                bounds.Width,
                bounds.Height,
                NativeMethods.SwpFrameChanged | NativeMethods.SwpShowWindow
            );
            _parentRestoreBounds = bounds;
            BeginInvoke(MaintainParentWindow);
            return;
        }
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
        if (_draggingParentWindow)
        {
            _draggingParentWindow = false;
            _parentDragStarted = false;
            if (NativeMethods.GetWindowRect(_parentHandle, out var parentRect))
            {
                _parentRestoreBounds = parentRect.ToRectangle();
            }
            SendHostState();
            return;
        }
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

    private void BeginParentWindowDrag(int screenX, int screenY)
    {
        if (!TryResolveParentWindow()) return;
        if (!NativeMethods.GetWindowRect(_parentHandle, out var currentRect)) return;
        var currentBounds = currentRect.ToRectangle();

        _dragging = true;
        _draggingParentWindow = true;
        _parentDragStarted = false;
        _dragStart = new Point(screenX, screenY);
        _dragStartBounds = currentBounds;
        _dragPointerOffset = new Point(
            Math.Clamp(screenX - currentBounds.Left, 0, Math.Max(0, currentBounds.Width - 1)),
            Math.Clamp(screenY - currentBounds.Top, 0, Math.Max(0, currentBounds.Height - 1))
        );
        SetDockReady(false);
    }

    private void BeginNativeParentWindowMove(int screenX, int screenY)
    {
        ResolvePointerCoordinates(ref screenX, ref screenY);
        if (!TryResolveParentWindow()) return;
        if (!NativeMethods.GetWindowRect(_parentHandle, out var currentRect)) return;
        var currentBounds = currentRect.ToRectangle();

        if (_parentMaximized)
        {
            var restore = _parentRestoreBounds.Width > 0
                ? _parentRestoreBounds
                : GetDefaultParentRestoreBounds(Screen.FromHandle(_parentHandle).WorkingArea);
            var horizontalRatio = currentBounds.Width > 0
                ? Math.Clamp((screenX - currentBounds.Left) / (double)currentBounds.Width, 0.08d, 0.92d)
                : 0.5d;
            var gripX = (int)Math.Round(restore.Width * horizontalRatio);
            var gripY = Math.Clamp(screenY - currentBounds.Top, 0, GetParentChromeHeightPixels() - 1);
            currentBounds = new Rectangle(screenX - gripX, screenY - gripY, restore.Width, restore.Height);
            NativeMethods.SetWindowPos(
                _parentHandle,
                NativeMethods.HwndTop,
                currentBounds.X,
                currentBounds.Y,
                currentBounds.Width,
                currentBounds.Height,
                NativeMethods.SwpFrameChanged | NativeMethods.SwpShowWindow
            );
            _parentMaximized = false;
        }

        NativeMethods.ReleaseCapture();
        NativeMethods.PostMessage(
            _parentHandle,
            NativeMethods.WmNcLButtonDown,
            new IntPtr(NativeMethods.HtCaption),
            NativeMethods.PackScreenPoint(screenX, screenY)
        );

        if (NativeMethods.GetWindowRect(_parentHandle, out var movedRect))
        {
            var moved = movedRect.ToRectangle();
            var workingArea = Screen.FromHandle(_parentHandle).WorkingArea;
            _parentMaximized = RectanglesNearlyEqual(moved, workingArea);
            if (!_parentMaximized) _parentRestoreBounds = moved;
        }
        _dashboardChrome?.UpdateState(_parentMaximized);
        BeginInvoke(MaintainParentWindow);
        SendHostState();
    }

    private void BeginNativeDetachedWindowMove(int screenX, int screenY)
    {
        ResolvePointerCoordinates(ref screenX, ref screenY);
        if (_attached || !IsHandleCreated || IsDisposed) return;
        if (_maximized) RestoreDetachedWindowForDrag(screenX, screenY);

        _dragging = false;
        _draggingParentWindow = false;
        _parentDragStarted = false;
        SetDockReady(false);
        NativeMethods.SetForegroundWindow(Handle);
        NativeMethods.ReleaseCapture();
        _nativeDetachedMovePending = true;
        NativeMethods.PostMessage(
            Handle,
            NativeMethods.WmNcLButtonDown,
            new IntPtr(NativeMethods.HtCaption),
            NativeMethods.PackScreenPoint(screenX, screenY)
        );

        UpdateDetachedWindowAppearance();
        SendHostState();
    }

    private void FinishNativeDetachedWindowMove()
    {
        if (_attached || IsDisposed) return;
        if (NativeMethods.GetWindowRect(Handle, out var movedRect))
        {
            _savedDetachedBounds = movedRect.ToRectangle();
        }
        var pointer = Cursor.Position;
        if (IsParentDockPoint(pointer.X, pointer.Y))
        {
            AttachToParent(true);
            return;
        }
        UpdateDetachedWindowAppearance();
        SendHostState();
    }

    private void StartParentWindowMove(int screenX, int screenY)
    {
        _parentDragStarted = true;
        if (!_parentMaximized) return;

        var currentBounds = _dragStartBounds;
        var restore = _parentRestoreBounds.Width > 0
            ? _parentRestoreBounds
            : GetDefaultParentRestoreBounds(Screen.FromHandle(_parentHandle).WorkingArea);
        var horizontalRatio = currentBounds.Width > 0
            ? Math.Clamp((_dragStart.X - currentBounds.Left) / (double)currentBounds.Width, 0.08d, 0.92d)
            : 0.5d;
        var gripX = (int)Math.Round(restore.Width * horizontalRatio);
        var gripY = Math.Clamp(_dragStart.Y - currentBounds.Top, 0, GetParentChromeHeightPixels() - 1);
        _dragStartBounds = new Rectangle(screenX - gripX, screenY - gripY, restore.Width, restore.Height);
        _dragPointerOffset = new Point(gripX, gripY);
        NativeMethods.SetWindowPos(
            _parentHandle,
            NativeMethods.HwndTop,
            _dragStartBounds.X,
            _dragStartBounds.Y,
            _dragStartBounds.Width,
            _dragStartBounds.Height,
            NativeMethods.SwpFrameChanged | NativeMethods.SwpShowWindow
        );
        _parentMaximized = false;
        _dashboardChrome?.UpdateState(false);
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
        var gripY = Math.Clamp(
            _dragPointerOffset.Y,
            0,
            Math.Min(GetCurrentChromeHeightPixels() - 1, detachedSize.Height - 1)
        );
        var bounds = new Rectangle(screenX - gripX, screenY - gripY, detachedSize.Width, detachedSize.Height);
        DetachFromParent(bounds, false);
        _dragging = false;
        BeginNativeDetachedWindowMove(screenX, screenY);
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
        var gripY = Math.Clamp(screenY - maximizedBounds.Top, 0, GetCurrentChromeHeightPixels() - 1);
        _maximized = false;
        Bounds = new Rectangle(screenX - gripX, screenY - gripY, restoredSize.Width, restoredSize.Height);
        SendHostState();
    }

    private static void ResolvePointerCoordinates(ref int screenX, ref int screenY)
    {
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
                        else if (command.Equals("minimize", StringComparison.OrdinalIgnoreCase)) MinimizeActiveWindow();
                        else if (command.Equals("maximize", StringComparison.OrdinalIgnoreCase)) ToggleMaximize();
                        else if (command.Equals("hide_to_tray", StringComparison.OrdinalIgnoreCase)) HideApplicationToTray();
                        else if (command.Equals("restore_dashboard", StringComparison.OrdinalIgnoreCase)) RestoreDashboardFromTray();
                        else if (command.Equals("close", StringComparison.OrdinalIgnoreCase)) Close();
                    });
                }
            }
            catch (OperationCanceledException) { break; }
            catch { await Task.Delay(200, cancellationToken); }
        }
    }

    protected override void WndProc(ref Message message)
    {
        if (message.Msg == NativeMethods.WmExitSizeMove && _nativeDetachedMovePending)
        {
            _nativeDetachedMovePending = false;
            BeginInvoke(FinishNativeDetachedWindowMove);
        }

        if (message.Msg == NativeMethods.WmNcHitTest && !_attached && !_maximized && WindowState == FormWindowState.Normal)
        {
            var packed = message.LParam.ToInt64();
            var screenPoint = new Point(
                unchecked((short)(packed & 0xffff)),
                unchecked((short)((packed >> 16) & 0xffff))
            );
            var clientPoint = PointToClient(screenPoint);
            var border = Math.Max(ResizeBorderThickness, DeviceDpi * ResizeBorderThickness / 96);
            var left = clientPoint.X >= 0 && clientPoint.X < border;
            var right = clientPoint.X < ClientSize.Width && clientPoint.X >= ClientSize.Width - border;
            var top = clientPoint.Y >= 0 && clientPoint.Y < border;
            var bottom = clientPoint.Y < ClientSize.Height && clientPoint.Y >= ClientSize.Height - border;

            var hit = top && left
                ? NativeMethods.HtTopLeft
                : top && right
                    ? NativeMethods.HtTopRight
                    : bottom && left
                        ? NativeMethods.HtBottomLeft
                        : bottom && right
                            ? NativeMethods.HtBottomRight
                            : left
                                ? NativeMethods.HtLeft
                                : right
                                    ? NativeMethods.HtRight
                                    : top
                                        ? NativeMethods.HtTop
                                        : bottom
                                            ? NativeMethods.HtBottom
                                            : NativeMethods.HtClient;
            if (hit != NativeMethods.HtClient)
            {
                message.Result = new IntPtr(hit);
                return;
            }
        }

        base.WndProc(ref message);
    }

    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        BeginInvoke(UpdateDetachedWindowAppearance);
    }

    protected override void OnSizeChanged(EventArgs e)
    {
        base.OnSizeChanged(e);
        if (IsHandleCreated) UpdateDetachedWindowAppearance();
    }

    private void UpdateDetachedWindowAppearance()
    {
        if (!IsHandleCreated || IsDisposed) return;
        var shouldRound = !_attached && !_maximized && WindowState == FormWindowState.Normal;
        var preference = shouldRound
            ? NativeMethods.DwmWindowCornerRound
            : NativeMethods.DwmWindowCornerDoNotRound;
        try
        {
            NativeMethods.DwmSetWindowAttribute(
                Handle,
                NativeMethods.DwmWindowCornerPreference,
                ref preference,
                sizeof(int)
            );
        }
        catch
        {
            // The native window region below still guarantees visible rounding.
        }

        if (!shouldRound)
        {
            ClearNativeWindowRegion();
            return;
        }

        ApplyNativeRoundedWindowRegion();
    }

    private void ApplyNativeRoundedWindowRegion()
    {
        if (!NativeMethods.GetWindowRect(Handle, out var bounds) || bounds.Width <= 0 || bounds.Height <= 0) return;
        var radius = Math.Max(RoundedCornerRadius, DeviceDpi * RoundedCornerRadius / 96);
        var region = NativeMethods.CreateRoundRectRgn(
            0,
            0,
            bounds.Width + 1,
            bounds.Height + 1,
            radius * 2,
            radius * 2
        );
        if (region == IntPtr.Zero) return;
        if (NativeMethods.SetWindowRgn(Handle, region, true) == 0)
        {
            NativeMethods.DeleteObject(region);
        }
    }

    private void ClearNativeWindowRegion()
    {
        NativeMethods.SetWindowRgn(Handle, IntPtr.Zero, true);
    }

    private sealed class WindowHandleOwner(IntPtr handle) : IWin32Window
    {
        public IntPtr Handle { get; } = handle;
    }

    protected override void OnFormClosing(FormClosingEventArgs e)
    {
        _parentTimer.Stop();
        _pipeCancellation.Cancel();
        if (_dashboardChrome != null && !_dashboardChrome.IsDisposed) _dashboardChrome.Close();
        if (_dashboardOverlay != null && !_dashboardOverlay.IsDisposed) _dashboardOverlay.Close();
        base.OnFormClosing(e);
    }
}
