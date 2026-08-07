using System.Drawing.Drawing2D;

namespace HeatTreatmentAdminHost;

internal sealed class DashboardChromeForm : Form
{
    internal const int ChromeHeight = 46;

    private readonly ChromeSurface _surface;
    private IntPtr _parentHandle;
    private Size _lastParentClientSize = Size.Empty;

    public DashboardChromeForm(Action<string, int, int> action)
    {
        Text = "实时大屏";
        FormBorderStyle = FormBorderStyle.None;
        StartPosition = FormStartPosition.Manual;
        ShowInTaskbar = false;
        MinimizeBox = false;
        MaximizeBox = false;
        MinimumSize = Size.Empty;
        BackColor = Color.FromArgb(237, 242, 247);
        Height = ChromeHeight;

        _surface = new ChromeSurface(action) { Dock = DockStyle.Fill };
        Controls.Add(_surface);
    }

    protected override bool ShowWithoutActivation => true;

    public void ShowForParent(IntPtr parentHandle, bool maximized)
    {
        if (IsDisposed || parentHandle == IntPtr.Zero) return;
        _parentHandle = parentHandle;

        var style = NativeMethods.GetWindowStyle(Handle, NativeMethods.GwlStyle);
        style &= ~(NativeMethods.WsPopup | NativeMethods.WsCaption | NativeMethods.WsThickFrame | NativeMethods.WsMinimizeBox | NativeMethods.WsMaximizeBox | NativeMethods.WsSysMenu);
        style |= NativeMethods.WsChild | NativeMethods.WsVisible | NativeMethods.WsClipChildren | NativeMethods.WsClipSiblings;
        NativeMethods.SetWindowStyle(Handle, NativeMethods.GwlStyle, style);
        var exStyle = NativeMethods.GetWindowStyle(Handle, NativeMethods.GwlExStyle);
        exStyle &= ~NativeMethods.WsExAppWindow;
        exStyle |= NativeMethods.WsExToolWindow;
        NativeMethods.SetWindowStyle(Handle, NativeMethods.GwlExStyle, exStyle);
        NativeMethods.SetParent(Handle, _parentHandle);

        UpdateParentBounds(force: true);
        UpdateState(maximized);
        Show();
        NativeMethods.ShowWindow(Handle, NativeMethods.SwShow);
    }

    public void UpdateParentBounds(bool force = false)
    {
        if (_parentHandle == IntPtr.Zero || !NativeMethods.IsWindow(_parentHandle)) return;
        if (!NativeMethods.GetClientRect(_parentHandle, out var client)) return;
        var clientSize = new Size(Math.Max(1, client.Width), Math.Max(1, client.Height));
        if (!force && clientSize == _lastParentClientSize) return;
        _lastParentClientSize = clientSize;
        NativeMethods.SetWindowPos(
            Handle,
            NativeMethods.HwndTop,
            0,
            0,
            clientSize.Width,
            ChromeHeight,
            NativeMethods.SwpFrameChanged | NativeMethods.SwpShowWindow
        );
    }

    public void UpdateState(bool maximized)
    {
        _surface.Maximized = maximized;
    }

    private sealed class ChromeSurface : Control
    {
        private const int ActionWidth = 40;
        private readonly Action<string, int, int> _action;
        private readonly Font _tabFont = new("Microsoft YaHei UI", 9f, FontStyle.Bold);
        private readonly Font _hintFont = new("Microsoft YaHei UI", 8.2f, FontStyle.Regular);
        private int _hoverZone;
        private bool _maximized;

        public ChromeSurface(Action<string, int, int> action)
        {
            _action = action;
            SetStyle(
                ControlStyles.AllPaintingInWmPaint
                | ControlStyles.OptimizedDoubleBuffer
                | ControlStyles.ResizeRedraw
                | ControlStyles.UserPaint,
                true
            );
            Cursor = Cursors.SizeAll;
        }

        public bool Maximized
        {
            get => _maximized;
            set
            {
                if (_maximized == value) return;
                _maximized = value;
                Invalidate();
            }
        }

        private Rectangle DashboardTabRect => new(8, 6, 108, 35);
        private Rectangle DetachedChipRect => new(126, 10, 204, 29);
        private Rectangle MinimizeRect => new(Math.Max(0, Width - ActionWidth * 3 - 6), 7, ActionWidth, 32);
        private Rectangle MaximizeRect => new(Math.Max(0, Width - ActionWidth * 2 - 6), 7, ActionWidth, 32);
        private Rectangle CloseRect => new(Math.Max(0, Width - ActionWidth - 6), 7, ActionWidth, 32);

        protected override void OnPaint(PaintEventArgs e)
        {
            base.OnPaint(e);
            var graphics = e.Graphics;
            graphics.SmoothingMode = SmoothingMode.AntiAlias;
            using (var background = new LinearGradientBrush(ClientRectangle, Color.FromArgb(237, 242, 247), Color.FromArgb(223, 231, 239), LinearGradientMode.Vertical))
            {
                graphics.FillRectangle(background, ClientRectangle);
            }
            using (var border = new Pen(Color.FromArgb(203, 213, 223)))
            {
                graphics.DrawLine(border, 0, Height - 1, Width, Height - 1);
            }

            DrawDashboardTab(graphics);
            DrawDetachedChip(graphics);
            DrawWindowActions(graphics);
        }

        private void DrawDashboardTab(Graphics graphics)
        {
            var rect = DashboardTabRect;
            using var path = RoundedPath(rect, 9);
            using var fill = new SolidBrush(Color.FromArgb(248, 250, 252));
            using var border = new Pen(Color.FromArgb(203, 213, 223));
            graphics.FillPath(fill, path);
            graphics.DrawPath(border, path);
            using var bottomMask = new Pen(Color.FromArgb(248, 250, 252), 2f);
            graphics.DrawLine(bottomMask, rect.Left + 12, rect.Bottom, rect.Right - 12, rect.Bottom);

            using var iconPen = new Pen(Color.FromArgb(71, 84, 103), 1.45f);
            var monitor = new Rectangle(rect.Left + 15, rect.Top + 10, 14, 10);
            graphics.DrawRectangle(iconPen, monitor);
            graphics.DrawLine(iconPen, monitor.Left + 5, monitor.Bottom + 3, monitor.Right - 5, monitor.Bottom + 3);
            graphics.DrawLine(iconPen, monitor.Left + 7, monitor.Bottom, monitor.Left + 7, monitor.Bottom + 3);

            TextRenderer.DrawText(
                graphics,
                "实时大屏",
                _tabFont,
                new Rectangle(rect.Left + 39, rect.Top + 6, rect.Width - 44, rect.Height - 8),
                Color.FromArgb(23, 43, 63),
                TextFormatFlags.VerticalCenter | TextFormatFlags.Left | TextFormatFlags.NoPadding
            );
        }

        private void DrawDetachedChip(Graphics graphics)
        {
            var rect = DetachedChipRect;
            var hovered = _hoverZone == 1;
            using var path = RoundedPath(rect, 7);
            using var fill = new SolidBrush(hovered ? Color.FromArgb(247, 250, 253) : Color.FromArgb(237, 242, 247));
            graphics.FillPath(fill, path);

            using var dot = new SolidBrush(Color.FromArgb(18, 183, 106));
            graphics.FillEllipse(dot, rect.Left + 10, rect.Top + 10, 7, 7);
            using var halo = new Pen(Color.FromArgb(55, 18, 183, 106), 3f);
            graphics.DrawEllipse(halo, rect.Left + 8, rect.Top + 8, 11, 11);

            TextRenderer.DrawText(
                graphics,
                "后台管理已在独立窗口",
                _hintFont,
                new Rectangle(rect.Left + 27, rect.Top + 2, rect.Width - 33, rect.Height - 4),
                hovered ? Color.FromArgb(23, 92, 211) : Color.FromArgb(82, 103, 122),
                TextFormatFlags.VerticalCenter | TextFormatFlags.Left | TextFormatFlags.NoPadding
            );
        }

        private void DrawWindowActions(Graphics graphics)
        {
            DrawActionBackground(graphics, MinimizeRect, _hoverZone == 2, false);
            DrawActionBackground(graphics, MaximizeRect, _hoverZone == 3, false);
            DrawActionBackground(graphics, CloseRect, _hoverZone == 4, true);
            var iconColor = _hoverZone == 4 ? Color.White : Color.FromArgb(71, 84, 103);
            using var pen = new Pen(iconColor, 1.5f) { StartCap = LineCap.Round, EndCap = LineCap.Round };

            var minimize = MinimizeRect;
            graphics.DrawLine(pen, minimize.Left + 13, minimize.Top + 21, minimize.Left + 27, minimize.Top + 21);

            var max = MaximizeRect;
            if (_maximized)
            {
                graphics.DrawRectangle(pen, max.Left + 15, max.Top + 8, 11, 11);
                graphics.DrawRectangle(pen, max.Left + 11, max.Top + 12, 11, 11);
            }
            else
            {
                graphics.DrawRectangle(pen, max.Left + 13, max.Top + 9, 14, 14);
            }

            var close = CloseRect;
            graphics.DrawLine(pen, close.Left + 13, close.Top + 10, close.Left + 27, close.Top + 24);
            graphics.DrawLine(pen, close.Left + 27, close.Top + 10, close.Left + 13, close.Top + 24);
        }

        private static void DrawActionBackground(Graphics graphics, Rectangle rect, bool hovered, bool close)
        {
            if (!hovered) return;
            using var path = RoundedPath(rect, 7);
            using var brush = new SolidBrush(close ? Color.FromArgb(229, 72, 77) : Color.FromArgb(217, 225, 233));
            graphics.FillPath(brush, path);
        }

        protected override void OnMouseMove(MouseEventArgs e)
        {
            base.OnMouseMove(e);
            var zone = DetachedChipRect.Contains(e.Location)
                ? 1
                : MinimizeRect.Contains(e.Location)
                    ? 2
                : MaximizeRect.Contains(e.Location)
                    ? 3
                    : CloseRect.Contains(e.Location)
                        ? 4
                        : 0;
            if (_hoverZone != zone)
            {
                _hoverZone = zone;
                Cursor = zone == 0 ? Cursors.SizeAll : Cursors.Hand;
                Invalidate();
            }
        }

        protected override void OnMouseDown(MouseEventArgs e)
        {
            base.OnMouseDown(e);
            if (e.Button != MouseButtons.Left || IsInteractiveZone(e.Location)) return;
            var pointer = Cursor.Position;
            _action("move_parent_native", pointer.X, pointer.Y);
        }

        protected override void OnMouseLeave(EventArgs e)
        {
            base.OnMouseLeave(e);
            _hoverZone = 0;
            Cursor = Cursors.SizeAll;
            Invalidate();
        }

        protected override void OnMouseUp(MouseEventArgs e)
        {
            base.OnMouseUp(e);
            if (e.Button != MouseButtons.Left) return;
            if (DetachedChipRect.Contains(e.Location)) _action("focus_admin", Cursor.Position.X, Cursor.Position.Y);
            else if (MinimizeRect.Contains(e.Location)) _action("minimize", Cursor.Position.X, Cursor.Position.Y);
            else if (MaximizeRect.Contains(e.Location)) _action("maximize", Cursor.Position.X, Cursor.Position.Y);
            else if (CloseRect.Contains(e.Location)) _action("close", Cursor.Position.X, Cursor.Position.Y);
        }

        private bool IsInteractiveZone(Point location)
        {
            return DetachedChipRect.Contains(location)
                || MinimizeRect.Contains(location)
                || MaximizeRect.Contains(location)
                || CloseRect.Contains(location);
        }

        private static GraphicsPath RoundedPath(Rectangle rect, int radius)
        {
            var diameter = radius * 2;
            var path = new GraphicsPath();
            path.AddArc(rect.Left, rect.Top, diameter, diameter, 180, 90);
            path.AddArc(rect.Right - diameter, rect.Top, diameter, diameter, 270, 90);
            path.AddArc(rect.Right - diameter, rect.Bottom - diameter, diameter, diameter, 0, 90);
            path.AddArc(rect.Left, rect.Bottom - diameter, diameter, diameter, 90, 90);
            path.CloseFigure();
            return path;
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                _tabFont.Dispose();
                _hintFont.Dispose();
            }
            base.Dispose(disposing);
        }
    }
}
