using System.Text.Json;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace ThreeDEarth;

/// <summary>
/// One borderless window per monitor, parented into the desktop layer behind the
/// icons, hosting the WebGL scene in WebView2.
/// </summary>
internal sealed class WallpaperWindow : Form
{
    public const string Origin = "https://earth.local";

    private readonly WebView2 _web;
    private readonly CoreWebView2Environment _env;
    private readonly Func<AppSettings> _settings;
    private bool _ready;
    private bool _paused;

    public Screen Screen { get; }

    /// <summary>Raised when the shared WebView2 browser process has died.</summary>
    public event Action? BrowserCrashed;

    private readonly bool _preview;

    public WallpaperWindow(Screen screen, CoreWebView2Environment env, Func<AppSettings> settings, bool preview = false)
    {
        Screen = screen;
        _env = env;
        _settings = settings;
        _preview = preview;

        AutoScaleMode = AutoScaleMode.None;
        BackColor = Color.Black;
        if (preview)
        {
            // Troubleshooting: the same scene in an ordinary window.
            Text = "3D Earth preview";
            Icon = TrayContext.AppIcon;
            StartPosition = FormStartPosition.CenterScreen;
            Size = new Size(Math.Min(1280, screen.WorkingArea.Width - 80), Math.Min(760, screen.WorkingArea.Height - 80));
        }
        else
        {
            Text = "3D Earth wallpaper";
            FormBorderStyle = FormBorderStyle.None;
            ShowInTaskbar = false;
            StartPosition = FormStartPosition.Manual;
            Bounds = screen.Bounds;
        }

        _web = new WebView2 { Dock = DockStyle.Fill, DefaultBackgroundColor = Color.Black };
        Controls.Add(_web);
    }

    protected override bool ShowWithoutActivation => !_preview;

    protected override CreateParams CreateParams
    {
        get
        {
            var cp = base.CreateParams;
            if (!_preview) cp.ExStyle |= (int)(NativeMethods.WS_EX_TOOLWINDOW | NativeMethods.WS_EX_NOACTIVATE);
            return cp;
        }
    }

    public async Task InitializeAsync()
    {
        await _web.EnsureCoreWebView2Async(_env);
        var core = _web.CoreWebView2;
        core.Settings.AreDefaultContextMenusEnabled = false;
        core.Settings.AreDevToolsEnabled = Environment.GetCommandLineArgs().Contains("--devtools");
        core.Settings.IsStatusBarEnabled = false;
        core.Settings.IsZoomControlEnabled = false;
        core.Settings.AreBrowserAcceleratorKeysEnabled = false;
        core.Settings.IsPinchZoomEnabled = false;
        core.Settings.IsSwipeNavigationEnabled = false;

        core.AddWebResourceRequestedFilter($"{Origin}/*", CoreWebView2WebResourceContext.All);
        core.WebResourceRequested += OnWebResourceRequested;
        core.WebMessageReceived += OnWebMessage;
        core.ProcessFailed += (_, e) =>
        {
            Log.Info($"WebView2 process failed: {e.ProcessFailedKind}");
            _ready = false;
            if (e.ProcessFailedKind == CoreWebView2ProcessFailedKind.BrowserProcessExited)
                BrowserCrashed?.Invoke();
            else
                BeginInvoke(() => { try { core.Reload(); } catch { /* window is going away */ } });
        };
        core.NavigationCompleted += (_, e) =>
            Log.Info($"[{LogName()}] navigation {(e.IsSuccess ? "ok" : "FAILED: " + e.WebErrorStatus)} (HTTP {e.HttpStatusCode})");
        Log.Info($"[{LogName()}] WebView2 ready; navigating");
        core.Navigate($"{Origin}/index.html");
    }

    // Serves ./web and the downloaded data folder (as /data/...) from one origin,
    // so WebGL can use every image without cross-origin restrictions.
    private void OnWebResourceRequested(object? sender, CoreWebView2WebResourceRequestedEventArgs e)
    {
        try
        {
            var uri = new Uri(e.Request.Uri);
            string rel = Uri.UnescapeDataString(uri.AbsolutePath).TrimStart('/');
            string root = Paths.Web;
            if (rel.StartsWith("data/", StringComparison.OrdinalIgnoreCase))
            {
                root = Paths.Data;
                rel = rel[5..];
            }
            if (rel.Length == 0) rel = "index.html";

            string rootFull = Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
            string full = Path.GetFullPath(Path.Combine(rootFull, rel));
            if (!full.StartsWith(rootFull, StringComparison.OrdinalIgnoreCase) || !File.Exists(full))
            {
                e.Response = _env.CreateWebResourceResponse(null, 404, "Not Found", "Content-Type: text/plain");
                return;
            }

            byte[] bytes;
            using (var fs = new FileStream(full, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
            {
                bytes = new byte[fs.Length];
                fs.ReadExactly(bytes);
            }
            string headers = $"Content-Type: {MimeType(full)}\r\nCache-Control: no-store\r\nAccess-Control-Allow-Origin: *";
            e.Response = _env.CreateWebResourceResponse(new MemoryStream(bytes), 200, "OK", headers);
        }
        catch (Exception ex)
        {
            Log.Error("Serving " + e.Request.Uri, ex);
            e.Response = _env.CreateWebResourceResponse(null, 500, "Error", "Content-Type: text/plain");
        }
    }

    private static string MimeType(string path) => Path.GetExtension(path).ToLowerInvariant() switch
    {
        ".html" => "text/html; charset=utf-8",
        ".js" or ".mjs" => "text/javascript; charset=utf-8",
        ".json" => "application/json",
        ".css" => "text/css",
        ".jpg" or ".jpeg" => "image/jpeg",
        ".png" => "image/png",
        ".webp" => "image/webp",
        ".svg" => "image/svg+xml",
        _ => "application/octet-stream",
    };

    private void OnWebMessage(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        try
        {
            using var doc = JsonDocument.Parse(e.WebMessageAsJson);
            string type = doc.RootElement.TryGetProperty("type", out var t) ? t.GetString() ?? "" : "";
            if (type == "log")
            {
                Log.Info($"[{LogName()} page] {doc.RootElement.GetProperty("message").GetString()}");
            }
            else if (type == "ready")
            {
                Log.Info($"[{LogName()}] scene ready");
                _ready = true;
                SendSettings(_settings());
                Post(new { type = "pause", paused = _paused });
            }
        }
        catch (Exception ex) { Log.Error("Web message", ex); }
    }

    private string LogName() => _preview ? "preview" : Screen.DeviceName.TrimStart('\\', '.');

    private void Post(object message)
    {
        if (!_ready || IsDisposed || _web.CoreWebView2 == null) return;
        try { _web.CoreWebView2.PostWebMessageAsJson(JsonSerializer.Serialize(message, AppSettings.Json)); }
        catch (Exception ex) { Log.Error("Posting to page", ex); }
    }

    public void SendSettings(AppSettings s) => Post(new { type = "settings", settings = s });

    public void NotifyDataChanged() => Post(new { type = "data" });

    public void SetPaused(bool paused)
    {
        if (_paused == paused) return;
        _paused = paused;
        Post(new { type = "pause", paused });
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing) _web.Dispose();
        base.Dispose(disposing);
    }
}
