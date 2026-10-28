namespace Cats.DesktopControl.Windows;

internal sealed record WindowInfo(long Hwnd, uint Pid, string Path, string Title, Bounds Bounds, bool Minimized, bool Foreground);

internal sealed record Bounds(int X, int Y, int Width, int Height)
{
    public static Bounds From(Native.Rect rect) => new(rect.Left, rect.Top, rect.Width, rect.Height);
}

/// <summary>Top-level application windows: visible, not cloaked, and not owned tool windows.</summary>
internal static class WindowCatalog
{
    public static List<WindowInfo> All()
    {
        var foreground = Native.GetForegroundWindow();
        var windows = new List<WindowInfo>();
        Native.EnumWindows((hwnd, _) =>
        {
            if (!IsApplicationWindow(hwnd)) return true;
            Native.GetWindowThreadProcessId(hwnd, out var pid);
            var path = Native.ProcessPath(pid);
            if (path is null) return true;
            windows.Add(new WindowInfo(hwnd.ToInt64(), pid, path, Native.WindowTitle(hwnd),
                Bounds.From(Native.FrameBounds(hwnd)), Native.IsIconic(hwnd), hwnd == foreground));
            return true;
        }, IntPtr.Zero);
        return windows;
    }

    public static WindowInfo? Find(long hwnd) => All().FirstOrDefault(window => window.Hwnd == hwnd);

    private static bool IsApplicationWindow(IntPtr hwnd)
    {
        if (!Native.IsWindowVisible(hwnd) || Native.IsCloaked(hwnd)) return false;
        if (Native.GetWindowTextLengthW(hwnd) == 0) return false;
        var style = Native.GetWindowLongPtr(hwnd, Native.GwlExStyle).ToInt64();
        if ((style & Native.WsExAppWindow) != 0) return true;
        if ((style & Native.WsExToolWindow) != 0) return false;
        return Native.GetWindow(hwnd, Native.GwOwner) == IntPtr.Zero;
    }
}
