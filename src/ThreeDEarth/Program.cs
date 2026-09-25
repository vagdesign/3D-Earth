namespace ThreeDEarth;

internal static class Program
{
    public const string AppName = "3D Earth";
    private const string MutexName = @"Local\ThreeDEarth.Wallpaper";
    public const string ShowSettingsEventName = @"Local\ThreeDEarth.ShowSettings";

    [STAThread]
    private static void Main(string[] args)
    {
        using var mutex = new Mutex(true, MutexName, out bool firstInstance);
        if (!firstInstance)
        {
            // Already running: ask the running copy to open its settings window.
            try
            {
                using var ev = EventWaitHandle.OpenExisting(ShowSettingsEventName);
                ev.Set();
            }
            catch { /* the other instance is still starting up */ }
            return;
        }

        Application.SetUnhandledExceptionMode(UnhandledExceptionMode.CatchException);
        Application.ThreadException += (_, e) => Log.Error("UI thread", e.Exception);
        AppDomain.CurrentDomain.UnhandledException += (_, e) => Log.Error("Unhandled", e.ExceptionObject as Exception);

        ApplicationConfiguration.Initialize();
        Application.Run(new TrayContext(args));
    }
}
