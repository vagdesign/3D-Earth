using static ThreeDEarth.NativeMethods;

namespace ThreeDEarth;

/// <summary>
/// Finds the desktop window layer that sits between the static wallpaper and the
/// desktop icons, and parents wallpaper windows into it.
///
/// Sending the undocumented message 0x052C to Progman makes Explorer create a
/// "WorkerW" window behind the icon view (the same thing Windows does for its
/// slideshow fade animation). Two layouts exist:
///  * Windows 10 / Windows 11 before 24H2: the icons (SHELLDLL_DefView) live in a
///    top-level WorkerW; the next top-level WorkerW is the wallpaper layer.
///  * Windows 11 24H2 and later: SHELLDLL_DefView and the WorkerW are children of
///    Progman. Our window becomes a layered child of Progman, placed below the
///    icon view and above the WorkerW.
/// </summary>
internal sealed class DesktopLayer
{
    public IntPtr Parent { get; private set; }
    public IntPtr DefView { get; private set; }
    public IntPtr WorkerW { get; private set; }
    public bool RaisedDesktop { get; private set; }

    public bool IsValid => Parent != IntPtr.Zero && IsWindow(Parent);

    public bool Locate()
    {
        Parent = DefView = WorkerW = IntPtr.Zero;
        RaisedDesktop = false;

        IntPtr progman = FindWindow("Progman", null);
        if (progman == IntPtr.Zero) return false;

        SendMessageTimeout(progman, 0x052C, new IntPtr(0xD), new IntPtr(0x1), SMTO_NORMAL, 1000, out _);
        SendMessageTimeout(progman, 0x052C, IntPtr.Zero, IntPtr.Zero, SMTO_NORMAL, 1000, out _);

        IntPtr defView = FindWindowEx(progman, IntPtr.Zero, "SHELLDLL_DefView", null);
        if (defView != IntPtr.Zero)
        {
            IntPtr worker = FindWindowEx(progman, IntPtr.Zero, "WorkerW", null);
            if (worker != IntPtr.Zero)
            {
                RaisedDesktop = true;
                DefView = defView;
                WorkerW = worker;
                Parent = progman;
                Log.Info("Desktop layer: Windows 11 24H2+ layout");
                return true;
            }
        }

        IntPtr found = IntPtr.Zero, foundDefView = IntPtr.Zero;
        EnumWindows((top, _) =>
        {
            IntPtr dv = FindWindowEx(top, IntPtr.Zero, "SHELLDLL_DefView", null);
            if (dv != IntPtr.Zero)
            {
                foundDefView = dv;
                found = FindWindowEx(IntPtr.Zero, top, "WorkerW", null);
            }
            return true;
        }, IntPtr.Zero);

        DefView = foundDefView;
        WorkerW = found;
        Parent = found != IntPtr.Zero ? found : progman;
        Log.Info(found != IntPtr.Zero ? "Desktop layer: classic WorkerW layout" : "Desktop layer: falling back to Progman");
        return Parent != IntPtr.Zero;
    }

    /// <summary>Parents <paramref name="hwnd"/> into the layer covering <paramref name="screenBounds"/>.</summary>
    public void Attach(IntPtr hwnd, Rectangle screenBounds)
    {
        long ex = GetWindowLongPtr(hwnd, GWL_EXSTYLE).ToInt64();
        ex |= WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE;
        ex &= ~WS_EX_APPWINDOW;
        if (RaisedDesktop) ex |= WS_EX_LAYERED;
        SetWindowLongPtr(hwnd, GWL_EXSTYLE, new IntPtr(ex));
        if (RaisedDesktop) SetLayeredWindowAttributes(hwnd, 0, 255, LWA_ALPHA);

        SetParent(hwnd, Parent);
        Place(hwnd, screenBounds);
    }

    public void Place(IntPtr hwnd, Rectangle screenBounds)
    {
        var r = new RECT { Left = screenBounds.Left, Top = screenBounds.Top, Right = screenBounds.Right, Bottom = screenBounds.Bottom };
        MapWindowPoints(IntPtr.Zero, Parent, ref r, 2);

        if (RaisedDesktop)
        {
            // Directly below the icons...
            SetWindowPos(hwnd, DefView, r.Left, r.Top, r.Width, r.Height, SWP_NOACTIVATE | SWP_SHOWWINDOW);
            // ...and the stock wallpaper WorkerW below us.
            if (WorkerW != IntPtr.Zero)
                SetWindowPos(WorkerW, hwnd, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
        }
        else
        {
            SetWindowPos(hwnd, IntPtr.Zero, r.Left, r.Top, r.Width, r.Height, SWP_NOZORDER | SWP_NOACTIVATE | SWP_SHOWWINDOW);
        }
    }

    public bool Owns(IntPtr hwnd) => IsWindow(hwnd) && GetParent(hwnd) == Parent;

    /// <summary>Re-applies the user's static wallpaper so Explorer repaints the desktop after we leave.</summary>
    public static void RefreshStaticWallpaper()
    {
        try
        {
            var sb = new System.Text.StringBuilder(520);
            if (SystemParametersInfo(SPI_GETDESKWALLPAPER, (uint)sb.Capacity, sb, 0))
                SystemParametersInfo(SPI_SETDESKWALLPAPER, 0, sb, SPIF_SENDCHANGE);
        }
        catch (Exception ex) { Log.Error("Refreshing wallpaper", ex); }
    }
}
