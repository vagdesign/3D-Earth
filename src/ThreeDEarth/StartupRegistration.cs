using Microsoft.Win32;

namespace ThreeDEarth;

/// <summary>Per-user "start with Windows" via HKCU\...\Run (no admin rights needed).</summary>
internal static class StartupRegistration
{
    private const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
    private const string ValueName = "3D Earth";

    private static string Command => $"\"{Environment.ProcessPath}\" --autostart";

    public static bool IsEnabled
    {
        get
        {
            using var key = Registry.CurrentUser.OpenSubKey(RunKey);
            return key?.GetValue(ValueName) is string s && s.Length > 0;
        }
    }

    public static void Set(bool enabled)
    {
        try
        {
            using var key = Registry.CurrentUser.CreateSubKey(RunKey, writable: true);
            if (enabled) key.SetValue(ValueName, Command);
            else if (key.GetValue(ValueName) != null) key.DeleteValue(ValueName);
        }
        catch (Exception ex) { Log.Error("Startup registration", ex); }
    }

    /// <summary>Keeps the Run entry pointing at the current executable (e.g. after an update).</summary>
    public static void Repair()
    {
        if (IsEnabled) Set(true);
    }
}
