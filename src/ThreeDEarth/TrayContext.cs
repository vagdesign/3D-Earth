using Microsoft.Web.WebView2.Core;
using Microsoft.Win32;

namespace ThreeDEarth;

/// <summary>
/// Application core: tray icon + menu, one wallpaper window per monitor, a
/// watchdog that re-attaches after Explorer restarts or display changes, power
/// saving, and the weather/texture downloader.
/// </summary>
internal sealed class TrayContext : ApplicationContext
{
    public static Icon AppIcon { get; } = LoadIcon();

    private readonly NotifyIcon _tray;
    private readonly DataService _data;
    private readonly UpdateService _updates = new();
    private ToolStripMenuItem? _updateItem;
    private bool _installing;
    private readonly List<WallpaperWindow> _windows = [];
    private readonly DesktopLayer _layer = new();
    private readonly System.Windows.Forms.Timer _watchdog = new() { Interval = 2000 };
    private readonly System.Windows.Forms.Timer _rebuildDebounce = new() { Interval = 1500 };
    private readonly Control _ui = new();
    private readonly ShellListener _shell;
    private readonly EventWaitHandle _showSettingsEvent;
    private readonly RegisteredWaitHandle _showSettingsWait;
    private AppSettings _settings;
    private CoreWebView2Environment? _env;
    private SettingsForm? _settingsForm;
    private bool _userPaused;
    private bool _sessionLocked;
    private bool _building;

    public TrayContext(string[] args)
    {
        _ui.CreateControl();   // marshals background events onto the UI thread
        _settings = AppSettings.Load();

        _tray = new NotifyIcon { Icon = AppIcon, Text = Program.AppName, Visible = true, ContextMenuStrip = BuildMenu() };
        _tray.DoubleClick += (_, _) => ShowSettings();

        _data = new DataService(() => _settings);
        _data.DataChanged += () => RunOnUi(() => _windows.ForEach(w => w.NotifyDataChanged()));

        _watchdog.Tick += (_, _) => Watchdog();
        _rebuildDebounce.Tick += (_, _) => { _rebuildDebounce.Stop(); _ = RebuildAsync(); };
        SystemEvents.DisplaySettingsChanged += OnDisplayChanged;
        SystemEvents.SessionSwitch += OnSessionSwitch;
        SystemEvents.PowerModeChanged += OnPowerModeChanged;

        _shell = new ShellListener(() => RunOnUi(() => { Log.Info("Explorer restarted"); ScheduleRebuild(); }));

        _showSettingsEvent = new EventWaitHandle(false, EventResetMode.AutoReset, Program.ShowSettingsEventName);
        _showSettingsWait = ThreadPool.RegisterWaitForSingleObject(_showSettingsEvent, (_, _) => RunOnUi(ShowSettings), null, -1, false);

        StartupRegistration.Repair();
        if (!_settings.FirstRunDone)
        {
            _settings.FirstRunDone = true;
            _settings.Save();
            _tray.ShowBalloonTip(8000, Program.AppName,
                "Your live Earth wallpaper is running. Right-click the globe in the notification area for views and settings.",
                ToolTipIcon.Info);
        }

        _ = StartAsync(args.Contains("--settings"));
    }

    private static Icon LoadIcon()
    {
        using var s = typeof(TrayContext).Assembly.GetManifestResourceStream("Earth.ico");
        return s != null ? new Icon(s) : SystemIcons.Application;
    }

    private async Task StartAsync(bool openSettings)
    {
        try
        {
            string version = CoreWebView2Environment.GetAvailableBrowserVersionString();
            Log.Info($"Starting 3D Earth {Application.ProductVersion}; WebView2 runtime {version}; OS {Environment.OSVersion}; " +
                     $"build {Microsoft.Win32.Registry.GetValue(@"HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows NT\CurrentVersion", "DisplayVersion", "?")}; " +
                     $"screens: {string.Join(", ", Screen.AllScreens.Select(sc => sc.Bounds.ToString()))}");
        }
        catch (WebView2RuntimeNotFoundException)
        {
            var r = MessageBox.Show(
                "3D Earth needs the Microsoft Edge WebView2 Runtime, which is not installed.\n\nOpen the download page now?",
                Program.AppName, MessageBoxButtons.YesNo, MessageBoxIcon.Warning);
            if (r == DialogResult.Yes)
                System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo("https://go.microsoft.com/fwlink/p/?LinkId=2124703") { UseShellExecute = true });
            ExitThread();
            return;
        }

        await StartBrowserAsync();
        if (Environment.GetCommandLineArgs().Contains("--preview")) await ShowPreviewAsync();
        await RebuildAsync();
        _watchdog.Start();
        _data.Start();
        _updates.UpdateAvailable += r => RunOnUi(() => OnUpdateAvailable(r));
        if (_settings.AutoCheckUpdates) _updates.Start();
        if (openSettings) ShowSettings();
    }

    // ------------------------------------------------------------------ windows

    private void ScheduleRebuild()
    {
        _rebuildDebounce.Stop();
        _rebuildDebounce.Start();
    }

    private async Task RebuildAsync()
    {
        if (_env == null || _building) return;
        _building = true;
        try
        {
            CloseWindows();
            if (!_layer.Locate())
            {
                Log.Info("Desktop layer not found yet; retrying");
                ScheduleRebuild();
                return;
            }

            var screens = _settings.Monitors == "primary"
                ? Screen.AllScreens.Where(s => s.Primary)
                : Screen.AllScreens;

            foreach (var screen in screens)
            {
                var w = new WallpaperWindow(screen, _env, () => _settings);
                w.BrowserCrashed += () => RunOnUi(() => { _ = RestartBrowserAsync(); });
                _ = w.Handle;                     // create the HWND without showing it on top first
                _layer.Attach(w.Handle, screen.Bounds);
                w.Show();
                _layer.Place(w.Handle, screen.Bounds);
                _windows.Add(w);
                await w.InitializeAsync();
            }
            Log.Info($"Wallpaper on {_windows.Count} monitor(s); " + _layer.Describe());
            UpdatePause();
        }
        catch (Exception ex)
        {
            Log.Error("Building wallpaper windows", ex);
            ScheduleRebuild();
        }
        finally { _building = false; }
    }

    private bool _restarting;

    private async Task RestartBrowserAsync()
    {
        if (_restarting) return;
        _restarting = true;
        try
        {
            await RestartBrowserCoreAsync();
        }
        catch (Exception ex) { Log.Error("Restarting WebView2", ex); }
        finally { _restarting = false; }
    }

    private async Task RestartBrowserCoreAsync()
    {
        Log.Info("WebView2 browser process exited; restarting it");
        CloseWindows();
        _env = null;
        await Task.Delay(3000);
        await StartBrowserAsync();
        await RebuildAsync();
    }

    private async Task StartBrowserAsync()
    {
        var options = new CoreWebView2EnvironmentOptions(
            "--disable-features=CalculateNativeWinOcclusion " +
            "--disable-background-timer-throttling --disable-backgrounding-occluded-windows --disable-renderer-backgrounding");
        _env = await CoreWebView2Environment.CreateAsync(null, Paths.WebViewData, options);
    }

    private void CloseWindows()
    {
        foreach (var w in _windows)
        {
            try { w.Close(); w.Dispose(); } catch { /* parent may already be gone */ }
        }
        _windows.Clear();
    }

    private readonly Queue<DateTime> _reattachTimes = new();
    private bool _reattachSuspended;

    private void Watchdog()
    {
        if (_building || _env == null) return;
        // Explorer restarted or the desktop layer was recreated -> re-attach.
        if (!_reattachSuspended && (!_layer.IsValid || _windows.Any(w => w.IsDisposed || !w.IsHandleCreated || !_layer.Owns(w.Handle))))
        {
            // Never loop: at most 3 automatic re-attaches in 5 minutes.
            var now = DateTime.UtcNow;
            while (_reattachTimes.Count > 0 && now - _reattachTimes.Peek() > TimeSpan.FromMinutes(5)) _reattachTimes.Dequeue();
            if (_reattachTimes.Count >= 3)
            {
                _reattachSuspended = true;
                Log.Info("Re-attach keeps failing; automatic re-attach suspended. " + _layer.Describe());
                _tray.ShowBalloonTip(8000, Program.AppName,
                    "The wallpaper could not stay attached to the desktop. Right-click the globe → Troubleshooting.",
                    ToolTipIcon.Warning);
                return;
            }
            _reattachTimes.Enqueue(now);
            Log.Info("Desktop layer changed; re-attaching. " + _layer.Describe());
            _ = RebuildAsync();
            return;
        }
        UpdatePause();
    }

    private void UpdatePause()
    {
        bool globalPause = _userPaused || _sessionLocked || (_settings.PauseOnBattery && CoverageMonitor.OnBattery);
        foreach (var w in _windows)
        {
            bool covered = _settings.PauseWhenCovered && CoverageMonitor.IsCovered(w.Screen);
            w.SetPaused(globalPause || covered);
        }
    }

    // ------------------------------------------------------------------ settings

    private void ApplySettings(AppSettings s)
    {
        bool monitorsChanged = s.Monitors != _settings.Monitors;
        bool qualityChanged = s.Quality != _settings.Quality;
        bool surfaceChanged = s.SurfaceTexture != _settings.SurfaceTexture;
        bool refreshChanged = s.WeatherRefreshMinutes != _settings.WeatherRefreshMinutes || s.CustomCloudUrl != _settings.CustomCloudUrl;
        _settings = s;
        _settings.Save();
        if (_settings.AutoCheckUpdates) _updates.Start(); else _updates.Stop();
        UpdateMenuChecks();

        if (monitorsChanged) { _ = RebuildAsync(); return; }
        foreach (var w in _windows) w.SendSettings(_settings);
        if (qualityChanged) _ = _data.RefreshAsync(forceTextures: true);
        else if (surfaceChanged) _ = _data.RefreshAsync();
        else if (refreshChanged) _data.Reschedule();
        UpdatePause();
    }

    private WallpaperWindow? _preview;

    private async Task ShowPreviewAsync(bool fullscreen = false)
    {
        if (_env == null) return;
        if (_preview is { IsDisposed: false }) _preview.Close();
        var screen = Screen.FromPoint(Cursor.Position);
        _preview = new WallpaperWindow(screen, _env, () => _settings, preview: true, fullscreen: fullscreen);
        _preview.FormClosed += (_, _) => _preview = null;
        _preview.Show();
        await _preview.InitializeAsync();
    }

    private void ShowSettings()
    {
        if (_settingsForm is { IsDisposed: false })
        {
            _settingsForm.Activate();
            return;
        }
        _settingsForm = new SettingsForm(_settings, ApplySettings, StatusText, () => _ = _data.RefreshAsync(),
                                         () => _ = CheckForUpdatesInteractiveAsync());
        _settingsForm.FormClosed += (_, _) => _settingsForm = null;
        _settingsForm.Show();
        _settingsForm.Activate();
    }

    // ------------------------------------------------------------------ updates

    private void OnUpdateAvailable(UpdateService.Release r)
    {
        if (_updateItem != null)
        {
            _updateItem.Text = $"Install update {r.Version.ToString(3)}…";
            _updateItem.Font = new Font(_updateItem.Font, FontStyle.Bold);
        }
        if (_settings.AutoInstallUpdates && UpdateService.IsInstalled)
        {
            _ = InstallUpdateAsync(r, ask: false);
            return;
        }
        _tray.BalloonTipClicked -= OnUpdateBalloonClicked;
        _tray.BalloonTipClicked += OnUpdateBalloonClicked;
        _tray.ShowBalloonTip(10000, $"{Program.AppName} {r.Version.ToString(3)} is available",
            "Click here, or right-click the globe → Install update.", ToolTipIcon.Info);
    }

    private void OnUpdateBalloonClicked(object? sender, EventArgs e)
    {
        _tray.BalloonTipClicked -= OnUpdateBalloonClicked;
        if (_updates.Available is { } r) _ = InstallUpdateAsync(r, ask: true);
    }

    private async Task UpdateMenuClickedAsync()
    {
        if (_updates.Available is { } known) { await InstallUpdateAsync(known, ask: true); return; }
        await CheckForUpdatesInteractiveAsync();
    }

    /// <summary>"Check now" from the menu or Settings: always tells the user the outcome.</summary>
    public async Task CheckForUpdatesInteractiveAsync()
    {
        var r = await _updates.CheckAsync();
        if (r != null) { await InstallUpdateAsync(r, ask: true); return; }
        if (!string.IsNullOrEmpty(_updates.LastError))
            MessageBox.Show(_updates.LastError, Program.AppName, MessageBoxButtons.OK, MessageBoxIcon.Warning);
        else
            MessageBox.Show($"You have the latest version ({UpdateService.CurrentVersion.ToString(3)}).", Program.AppName,
                MessageBoxButtons.OK, MessageBoxIcon.Information);
    }

    private async Task InstallUpdateAsync(UpdateService.Release r, bool ask)
    {
        if (_installing) return;
        if (!UpdateService.IsInstalled)
        {
            // Portable copy: there is no installation to update; open the download page.
            System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(r.PageUrl) { UseShellExecute = true });
            return;
        }
        if (ask)
        {
            string notes = r.Notes.Length > 600 ? r.Notes[..600] + "…" : r.Notes;
            var answer = MessageBox.Show(
                $"Install {Program.AppName} {r.Version.ToString(3)} now?\n(You have {UpdateService.CurrentVersion.ToString(3)}.)\n\n" +
                "The wallpaper closes for a few seconds and starts again by itself.\n\n" + notes,
                Program.AppName, MessageBoxButtons.YesNo, MessageBoxIcon.Question);
            if (answer != DialogResult.Yes) return;
        }
        _installing = true;
        string original = _tray.Text;
        var progress = new Progress<int>(p => _tray.Text = $"{Program.AppName}: downloading update {p}%");
        bool ok = await _updates.InstallAsync(r, progress);
        _installing = false;
        _tray.Text = original;
        if (ok) ExitThread();   // the installer replaces the files and restarts the app
        else MessageBox.Show(_updates.LastError, Program.AppName, MessageBoxButtons.OK, MessageBoxIcon.Warning);
    }

    private string StatusText()
    {
        var parts = new List<string>
        {
            $"Showing on {_windows.Count} monitor(s){(_layer.RaisedDesktop ? " (Windows 11 24H2 desktop)" : "")}.",
            _data.LastCloudUpdate is { } t ? $"Clouds updated {t:t}." : "Clouds: waiting for the first download.",
            $"Active tropical storms: {_data.LastStormCount}.",
            $"Cloud history: {_data.HistoryCount} map(s) over {_data.HistoryHours:0.#} h (the 24 h loop needs about an hour or more).",
        };
        parts.Add(_updates.Available is { } up
            ? $"Update {up.Version.ToString(3)} available."
            : _updates.LastCheck is { } lc ? $"Version {UpdateService.CurrentVersion.ToString(3)} is up to date (checked {lc:t})." : $"Version {UpdateService.CurrentVersion.ToString(3)}.");
        if (!string.IsNullOrEmpty(_data.LastError)) parts.Add("Last error: " + _data.LastError);
        if (!string.IsNullOrEmpty(_updates.LastError)) parts.Add(_updates.LastError);
        return string.Join(" ", parts);
    }

    // ------------------------------------------------------------------ tray menu

    private ToolStripMenuItem? _motionLive, _motionSpin, _motionLapse, _motionDayLapse;
    private ToolStripMenuItem? _viewMoon, _viewHome, _viewSunrise, _labelsItem, _stormsItem, _pauseItem, _autostartItem;

    private ContextMenuStrip BuildMenu()
    {
        var menu = new ContextMenuStrip();
        var title = new ToolStripMenuItem(Program.AppName) { Enabled = false };
        menu.Items.Add(title);
        menu.Items.Add(new ToolStripSeparator());

        var view = new ToolStripMenuItem("View");
        _viewMoon = new ToolStripMenuItem("Moon beside the Earth", null, (_, _) => SetView("moon"));
        _viewHome = new ToolStripMenuItem("Above my location", null, (_, _) => SetView("home"));
        _viewSunrise = new ToolStripMenuItem("Sunrise behind the Earth", null, (_, _) => SetView("sunrise"));
        view.DropDownItems.AddRange(new ToolStripItem[] { _viewMoon, _viewHome, _viewSunrise });
        menu.Items.Add(view);

        var motion = new ToolStripMenuItem("Motion");
        _motionLive = new ToolStripMenuItem("Real time", null, (_, _) => Toggle(s => s.Motion = "live"));
        _motionSpin = new ToolStripMenuItem("Spin 360° from my location", null, (_, _) => Toggle(s => s.Motion = "spin"));
        _motionLapse = new ToolStripMenuItem("Time-lapse", null, (_, _) => Toggle(s => s.Motion = "timelapse"));
        _motionDayLapse = new ToolStripMenuItem("Day && night time-lapse above my location", null, (_, _) => Toggle(s => s.Motion = "daylapse"));
        motion.DropDownItems.AddRange(new ToolStripItem[] { _motionLive, _motionSpin, _motionLapse, _motionDayLapse });
        menu.Items.Add(motion);

        _labelsItem = new ToolStripMenuItem("Moon and planet labels", null, (_, _) => Toggle(s => s.Labels = !s.Labels));
        _stormsItem = new ToolStripMenuItem("Storm labels", null, (_, _) => Toggle(s => s.Storms = !s.Storms));
        menu.Items.Add(new ToolStripMenuItem("Explore (full screen, Esc to exit)", null, (_, _) => _ = ShowPreviewAsync(fullscreen: true)));
        menu.Items.Add(new ToolStripMenuItem("Open in a window", null, (_, _) => _ = ShowPreviewAsync()));
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add(_labelsItem);
        menu.Items.Add(_stormsItem);
        menu.Items.Add(new ToolStripMenuItem("Update weather now", null, (_, _) => _ = _data.RefreshAsync()));
        menu.Items.Add(new ToolStripSeparator());
        _pauseItem = new ToolStripMenuItem("Pause", null, (_, _) => { _userPaused = !_userPaused; UpdateMenuChecks(); UpdatePause(); });
        menu.Items.Add(_pauseItem);
        _autostartItem = new ToolStripMenuItem("Start with Windows", null, (_, _) => { StartupRegistration.Set(!StartupRegistration.IsEnabled); UpdateMenuChecks(); });
        menu.Items.Add(_autostartItem);
        menu.Items.Add(new ToolStripMenuItem("Settings…", null, (_, _) => ShowSettings()) { Font = new Font(menu.Font, FontStyle.Bold) });
        var trouble = new ToolStripMenuItem("Troubleshooting");
        trouble.DropDownItems.Add(new ToolStripMenuItem("Preview in a window", null, (_, _) => _ = ShowPreviewAsync()));
        trouble.DropDownItems.Add(new ToolStripMenuItem("Re-attach to the desktop", null, (_, _) =>
        {
            _reattachSuspended = false;
            _reattachTimes.Clear();
            _ = RebuildAsync();
        }));
        trouble.DropDownItems.Add(new ToolStripMenuItem("Open log file", null, (_, _) =>
            System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(Paths.LogFile) { UseShellExecute = true })));
        menu.Items.Add(trouble);
        _updateItem = new ToolStripMenuItem("Check for updates", null, (_, _) => _ = UpdateMenuClickedAsync());
        menu.Items.Add(_updateItem);
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add(new ToolStripMenuItem("Exit", null, (_, _) => ExitThread()));
        menu.Opening += (_, _) => UpdateMenuChecks();
        return menu;
    }

    private void UpdateMenuChecks()
    {
        if (_viewMoon == null) return;
        _viewMoon.Checked = _settings.View == "moon";
        _viewHome!.Checked = _settings.View == "home";
        _viewSunrise!.Checked = _settings.View == "sunrise";
        _labelsItem!.Checked = _settings.Labels;
        _motionLive!.Checked = _settings.Motion == "live";
        _motionSpin!.Checked = _settings.Motion == "spin";
        _motionLapse!.Checked = _settings.Motion == "timelapse";
        _motionDayLapse!.Checked = _settings.Motion == "daylapse";
        _stormsItem!.Checked = _settings.Storms;
        _pauseItem!.Checked = _userPaused;
        _autostartItem!.Checked = StartupRegistration.IsEnabled;
    }

    private void SetView(string view) => Toggle(s => s.View = view);

    private void Toggle(Action<AppSettings> change)
    {
        var s = _settings.Clone();
        change(s);
        ApplySettings(s);
    }

    // ------------------------------------------------------------------ system events

    private void OnDisplayChanged(object? sender, EventArgs e) => RunOnUi(ScheduleRebuild);

    private void OnSessionSwitch(object? sender, SessionSwitchEventArgs e) => RunOnUi(() =>
    {
        if (e.Reason is SessionSwitchReason.SessionLock or SessionSwitchReason.ConsoleDisconnect or SessionSwitchReason.RemoteDisconnect)
            _sessionLocked = true;
        else if (e.Reason is SessionSwitchReason.SessionUnlock or SessionSwitchReason.ConsoleConnect or SessionSwitchReason.RemoteConnect)
            _sessionLocked = false;
        UpdatePause();
    });

    private void OnPowerModeChanged(object? sender, PowerModeChangedEventArgs e) => RunOnUi(() =>
    {
        if (e.Mode == PowerModes.Resume) { ScheduleRebuild(); _ = _data.RefreshAsync(); }
        UpdatePause();
    });

    private void RunOnUi(Action a)
    {
        if (_ui.IsDisposed) return;
        if (_ui.InvokeRequired) _ui.BeginInvoke(a);
        else a();
    }

    protected override void ExitThreadCore()
    {
        _watchdog.Stop();
        SystemEvents.DisplaySettingsChanged -= OnDisplayChanged;
        SystemEvents.SessionSwitch -= OnSessionSwitch;
        SystemEvents.PowerModeChanged -= OnPowerModeChanged;
        _showSettingsWait.Unregister(null);
        _showSettingsEvent.Dispose();
        _settingsForm?.Close();
        _preview?.Close();
        CloseWindows();
        DesktopLayer.RefreshStaticWallpaper();
        _data.Dispose();
        _updates.Dispose();
        _shell.DestroyHandle();
        _tray.Visible = false;
        _tray.Dispose();
        _ui.Dispose();
        base.ExitThreadCore();
    }

    /// <summary>Hidden top-level window that hears Explorer's "TaskbarCreated" broadcast.</summary>
    private sealed class ShellListener : NativeWindow
    {
        private readonly uint _taskbarCreated = NativeMethods.RegisterWindowMessage("TaskbarCreated");
        private readonly Action _onRestart;

        public ShellListener(Action onRestart)
        {
            _onRestart = onRestart;
            CreateHandle(new CreateParams { Caption = "3DEarth.ShellListener" });
        }

        protected override void WndProc(ref Message m)
        {
            if (m.Msg == (int)_taskbarCreated) _onRestart();
            base.WndProc(ref m);
        }
    }
}
