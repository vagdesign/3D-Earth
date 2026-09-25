namespace ThreeDEarth;

internal static class Paths
{
    public static string Roaming { get; } = Ensure(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "3D Earth"));
    public static string Local { get; } = Ensure(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "3D Earth"));
    public static string Data { get; } = Ensure(Path.Combine(Local, "data"));
    public static string WebViewData { get; } = Ensure(Path.Combine(Local, "WebView2"));
    public static string SettingsFile => Path.Combine(Roaming, "settings.json");
    public static string LogFile => Path.Combine(Local, "3DEarth.log");
    public static string Web => Path.Combine(AppContext.BaseDirectory, "web");

    private static string Ensure(string dir)
    {
        Directory.CreateDirectory(dir);
        return dir;
    }
}

internal static class Log
{
    private static readonly object Gate = new();

    public static void Info(string message) => Write("INFO ", message);

    public static void Error(string context, Exception? ex) => Write("ERROR", $"{context}: {ex}");

    private static void Write(string level, string message)
    {
        try
        {
            lock (Gate)
            {
                var file = new FileInfo(Paths.LogFile);
                if (file.Exists && file.Length > 1_000_000) file.Delete();
                File.AppendAllText(Paths.LogFile, $"{DateTime.Now:yyyy-MM-dd HH:mm:ss} {level} {message}{Environment.NewLine}");
            }
        }
        catch { /* logging must never crash the wallpaper */ }
    }
}
