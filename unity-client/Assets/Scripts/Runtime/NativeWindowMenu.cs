using System;
using System.Collections;
using System.Runtime.InteropServices;
using System.Threading;
using UnityEngine;

namespace HeatTreatment.DigitalTwin.Runtime
{
    /// <summary>
    /// Converts the Unity player into a clean borderless application shell. The visible
    /// browser-style chrome is supplied by the embedded admin host, so the default Windows
    /// caption and menu must not remain around the digital-twin interface.
    /// </summary>
    public sealed class NativeWindowMenu : MonoBehaviour
    {
        private bool _maximizeOnStart;

        public event Action SettingsRequested;

#if UNITY_STANDALONE_WIN && !UNITY_EDITOR
        private const int GwlStyle = -16;
        private const long WsChild = 0x40000000L;
        private const long WsVisible = 0x10000000L;
        private const long WsClipChildren = 0x02000000L;
        private const long WsClipSiblings = 0x04000000L;
        private const long WsPopup = unchecked((long)0x80000000);
        private const long WsCaption = 0x00C00000L;
        private const long WsThickFrame = 0x00040000L;
        private const long WsMinimizeBox = 0x00020000L;
        private const long WsMaximizeBox = 0x00010000L;
        private const long WsSysMenu = 0x00080000L;
        private const uint MonitorDefaultToNearest = 0x00000002;
        private const uint SwpFrameChanged = 0x0020;
        private const uint SwpShowWindow = 0x0040;
        private const int SwMaximize = 3;
        private const int DwmWindowCornerPreference = 33;
        private const int DwmWindowCornerDoNotRound = 1;
        private const int DwmWindowCornerRound = 2;

        private static readonly IntPtr HwndTop = IntPtr.Zero;

        private IntPtr _windowHandle;
        private int _openAdminRequested;
        private bool _installed;
        private int _lastCornerWidth = -1;
        private int _lastCornerHeight = -1;
        private bool _lastCornerMaximized;
        private float _nextCornerRefreshTime;

        [StructLayout(LayoutKind.Sequential)]
        private struct NativeRect
        {
            public int Left;
            public int Top;
            public int Right;
            public int Bottom;

            public int Width => Right - Left;
            public int Height => Bottom - Top;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct MonitorInfo
        {
            public int Size;
            public NativeRect Monitor;
            public NativeRect WorkArea;
            public uint Flags;
        }

        [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW", SetLastError = true)]
        private static extern IntPtr GetWindowLongPtr64(IntPtr window, int index);

        [DllImport("user32.dll", EntryPoint = "GetWindowLongW", SetLastError = true)]
        private static extern IntPtr GetWindowLongPtr32(IntPtr window, int index);

        [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW", SetLastError = true)]
        private static extern IntPtr SetWindowLongPtr64(IntPtr window, int index, IntPtr value);

        [DllImport("user32.dll", EntryPoint = "SetWindowLongW", SetLastError = true)]
        private static extern IntPtr SetWindowLongPtr32(IntPtr window, int index, IntPtr value);

        [DllImport("user32.dll", SetLastError = true)]
        private static extern bool GetWindowRect(IntPtr window, out NativeRect rect);

        [DllImport("user32.dll", SetLastError = true)]
        private static extern bool IsZoomed(IntPtr window);

        [DllImport("user32.dll", SetLastError = true)]
        private static extern bool ShowWindow(IntPtr window, int command);

        [DllImport("user32.dll", SetLastError = true)]
        private static extern bool SetWindowPos(
            IntPtr window,
            IntPtr insertAfter,
            int x,
            int y,
            int width,
            int height,
            uint flags
        );

        [DllImport("user32.dll", SetLastError = true)]
        private static extern IntPtr MonitorFromWindow(IntPtr window, uint flags);

        [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern bool GetMonitorInfo(IntPtr monitor, ref MonitorInfo info);

        [DllImport("user32.dll", SetLastError = true)]
        private static extern bool SetMenu(IntPtr window, IntPtr menu);

        [DllImport("user32.dll", SetLastError = true)]
        private static extern bool DrawMenuBar(IntPtr window);

        [DllImport("dwmapi.dll", PreserveSig = true)]
        private static extern int DwmSetWindowAttribute(
            IntPtr window,
            int attribute,
            ref int value,
            int valueSize
        );

        [DllImport("gdi32.dll", SetLastError = true)]
        private static extern IntPtr CreateRoundRectRgn(
            int left,
            int top,
            int right,
            int bottom,
            int ellipseWidth,
            int ellipseHeight
        );

        [DllImport("user32.dll", SetLastError = true)]
        private static extern int SetWindowRgn(IntPtr window, IntPtr region, bool redraw);

        [DllImport("gdi32.dll", SetLastError = true)]
        private static extern bool DeleteObject(IntPtr handle);

        [DllImport("user32.dll")]
        private static extern uint GetDpiForWindow(IntPtr window);
#endif

        public void Configure(bool maximizeOnStart)
        {
            _maximizeOnStart = maximizeOnStart;
        }

        private IEnumerator Start()
        {
#if UNITY_STANDALONE_WIN && !UNITY_EDITOR
            for (var attempt = 0; attempt < 180 && !_installed; attempt += 1)
            {
                TryInstallBorderlessShell();
                if (_installed) break;
                yield return null;
            }
            // Unity may restore its serialized window size a few frames after the
            // native borderless style is installed. Retry briefly during startup
            // so the standard Windows maximized state wins reliably.
            if (_installed && _maximizeOnStart)
            {
                var maximizeDeadline = Time.realtimeSinceStartup + 3f;
                while (Time.realtimeSinceStartup < maximizeDeadline && !IsZoomed(_windowHandle))
                {
                    ShowWindow(_windowHandle, SwMaximize);
                    yield return new WaitForSecondsRealtime(0.15f);
                }
                RefreshWindowCorners(true);
            }
#else
            yield break;
#endif
        }

        private void Update()
        {
#if UNITY_STANDALONE_WIN && !UNITY_EDITOR
            if (_installed && Time.unscaledTime >= _nextCornerRefreshTime)
            {
                _nextCornerRefreshTime = Time.unscaledTime + 0.2f;
                RefreshWindowCorners(false);
            }
            if (Input.GetKeyDown(KeyCode.F10)) Interlocked.Exchange(ref _openAdminRequested, 1);
            if (Interlocked.Exchange(ref _openAdminRequested, 0) == 1)
            {
                SettingsRequested?.Invoke();
            }
#endif
        }

#if UNITY_STANDALONE_WIN && !UNITY_EDITOR
        private void TryInstallBorderlessShell()
        {
            if (_installed) return;
            _windowHandle = System.Diagnostics.Process.GetCurrentProcess().MainWindowHandle;
            if (_windowHandle == IntPtr.Zero || !GetWindowRect(_windowHandle, out var originalBounds)) return;

            var style = GetWindowStyle(_windowHandle);
            style &= ~(WsChild | WsCaption);
            style |= WsPopup
                | WsVisible
                | WsClipChildren
                | WsClipSiblings
                | WsThickFrame
                | WsMinimizeBox
                | WsMaximizeBox
                | WsSysMenu;
            SetWindowStyle(_windowHandle, style);
            SetMenu(_windowHandle, IntPtr.Zero);
            DrawMenuBar(_windowHandle);

            // Commit the new borderless/thick-frame style before maximizing.
            // Windows can then compensate its invisible resize border so the
            // client area reaches every edge of the monitor work area.
            SetWindowPos(
                _windowHandle,
                HwndTop,
                originalBounds.Left,
                originalBounds.Top,
                Math.Max(1, originalBounds.Width),
                Math.Max(1, originalBounds.Height),
                SwpFrameChanged | SwpShowWindow
            );
            if (_maximizeOnStart) ShowWindow(_windowHandle, SwMaximize);
            _installed = true;
            RefreshWindowCorners(true);
            Debug.Log("[NativeWindowMenu] Borderless application shell installed; F10 opens the admin tab.");
        }

        private void RefreshWindowCorners(bool force)
        {
            if (_windowHandle == IntPtr.Zero || !GetWindowRect(_windowHandle, out var bounds)) return;
            var maximized = IsZoomed(_windowHandle);

            if (!force
                && bounds.Width == _lastCornerWidth
                && bounds.Height == _lastCornerHeight
                && maximized == _lastCornerMaximized)
            {
                return;
            }
            _lastCornerWidth = bounds.Width;
            _lastCornerHeight = bounds.Height;
            _lastCornerMaximized = maximized;

            var preference = maximized ? DwmWindowCornerDoNotRound : DwmWindowCornerRound;
            try
            {
                DwmSetWindowAttribute(
                    _windowHandle,
                    DwmWindowCornerPreference,
                    ref preference,
                    sizeof(int)
                );
            }
            catch
            {
                // The explicit window region below is the compatibility fallback.
            }

            if (maximized)
            {
                SetWindowRgn(_windowHandle, IntPtr.Zero, true);
                return;
            }

            var dpi = 96u;
            try
            {
                var detected = GetDpiForWindow(_windowHandle);
                if (detected > 0) dpi = detected;
            }
            catch
            {
                // Windows versions without GetDpiForWindow use 96 DPI.
            }
            var radius = Math.Max(12, (int)Math.Round(12d * dpi / 96d));
            var region = CreateRoundRectRgn(
                0,
                0,
                Math.Max(1, bounds.Width) + 1,
                Math.Max(1, bounds.Height) + 1,
                radius * 2,
                radius * 2
            );
            if (region == IntPtr.Zero) return;
            if (SetWindowRgn(_windowHandle, region, true) == 0)
            {
                DeleteObject(region);
            }
        }

        private static long GetWindowStyle(IntPtr window)
        {
            return (IntPtr.Size == 8 ? GetWindowLongPtr64(window, GwlStyle) : GetWindowLongPtr32(window, GwlStyle)).ToInt64();
        }

        private static void SetWindowStyle(IntPtr window, long style)
        {
            if (IntPtr.Size == 8) SetWindowLongPtr64(window, GwlStyle, new IntPtr(style));
            else SetWindowLongPtr32(window, GwlStyle, new IntPtr(style));
        }
#endif
    }
}
