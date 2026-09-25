using static ThreeDEarth.NativeMethods;

namespace ThreeDEarth;

/// <summary>
/// Decides when rendering can pause to save power: when a maximised or
/// full-screen window hides a monitor's wallpaper, on battery, or while the
/// session is locked.
/// </summary>
internal static class CoverageMonitor
{
    private static readonly HashSet<string> ShellClasses = new(StringComparer.OrdinalIgnoreCase)
    {
        "Progman", "WorkerW", "Shell_TrayWnd", "Shell_SecondaryTrayWnd", "Windows.UI.Core.CoreWindow",
        "XamlExplorerHostIslandWindow", "TopLevelWindowForOverflowXamlIsland", "NotifyIconOverflowWindow",
    };

    /// <summary>True if the foreground window completely covers <paramref name="screen"/>'s work area.</summary>
    public static bool IsCovered(Screen screen)
    {
        IntPtr fg = GetForegroundWindow();
        if (fg == IntPtr.Zero || !IsWindowVisible(fg) || IsIconic(fg) || IsCloaked(fg)) return false;
        if (ShellClasses.Contains(ClassNameOf(fg))) return false;
        if (!GetWindowRect(fg, out var r)) return false;

        var wa = screen.WorkingArea;
        // Allow a few pixels for the invisible resize borders of maximised windows.
        const int slack = 12;
        return r.Left <= wa.Left + slack && r.Top <= wa.Top + slack &&
               r.Right >= wa.Right - slack && r.Bottom >= wa.Bottom - slack;
    }

    public static bool OnBattery =>
        SystemInformation.PowerStatus.PowerLineStatus == PowerLineStatus.Offline;
}
