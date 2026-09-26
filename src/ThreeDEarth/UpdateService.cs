using System.Diagnostics;
using System.Net.Http.Headers;
using System.Reflection;
using System.Security.Cryptography;
using System.Text.Json.Nodes;
using Microsoft.Win32;

namespace ThreeDEarth;

/// <summary>
/// Checks GitHub Releases for a newer version and installs it: downloads the
/// setup .exe, verifies its size and SHA-256, runs it silently (it closes this
/// app, updates the files and starts the new version).
/// </summary>
internal sealed class UpdateService : IDisposable
{
    /// <summary>Public repository whose Releases carry the installers.</summary>
    public const string FeedRepo = "vagdesign/3D-Earth";
    private const string AppId = "{8C3F1E52-4B7A-4D0E-9E6B-3D5A0E1A2B7C}";

    public sealed record Release(Version Version, string Tag, string Name, string Notes,
                                 string InstallerUrl, string InstallerName, long Size, string? Sha256, string PageUrl);

    private readonly HttpClient _http;
    private System.Threading.Timer? _timer;

    public Release? Available { get; private set; }
    public DateTime? LastCheck { get; private set; }
    public string LastError { get; private set; } = "";
    public event Action<Release>? UpdateAvailable;

    public static Version CurrentVersion { get; } = Normalize(Assembly.GetExecutingAssembly().GetName().Version ?? new Version(0, 0));

    public UpdateService()
    {
        _http = new HttpClient { Timeout = TimeSpan.FromMinutes(10) };
        _http.DefaultRequestHeaders.UserAgent.Add(new ProductInfoHeaderValue("3DEarth", CurrentVersion.ToString(3)));
        _http.DefaultRequestHeaders.Accept.Add(new MediaTypeWithQualityHeaderValue("application/vnd.github+json"));
    }

    /// <summary>Automatic checks: shortly after start, then every 12 hours.</summary>
    public void Start()
    {
        _timer?.Dispose();
        _timer = new System.Threading.Timer(_ => _ = CheckAsync(), null, TimeSpan.FromMinutes(2), TimeSpan.FromHours(12));
    }

    public void Stop()
    {
        _timer?.Dispose();
        _timer = null;
    }

    public async Task<Release?> CheckAsync()
    {
        try
        {
            using var resp = await _http.GetAsync($"https://api.github.com/repos/{FeedRepo}/releases/latest");
            LastCheck = DateTime.Now;
            if (resp.StatusCode == System.Net.HttpStatusCode.NotFound)
            {
                LastError = "No public release feed found (the releases repository may be private).";
                return null;
            }
            resp.EnsureSuccessStatusCode();
            var root = JsonNode.Parse(await resp.Content.ReadAsStringAsync());
            string tag = root?["tag_name"]?.ToString() ?? "";
            if (!Version.TryParse(tag.TrimStart('v', 'V'), out var v)) { LastError = $"Unrecognised release tag '{tag}'."; return null; }
            v = Normalize(v);

            JsonNode? asset = (root?["assets"] as JsonArray)?.FirstOrDefault(a =>
            {
                string n = a?["name"]?.ToString() ?? "";
                return n.StartsWith("3DEarth-Setup-", StringComparison.OrdinalIgnoreCase) && n.EndsWith(".exe", StringComparison.OrdinalIgnoreCase);
            });
            LastError = "";
            if (v <= CurrentVersion || asset == null) { Available = null; return null; }

            string? digest = asset["digest"]?.ToString();
            var release = new Release(
                v, tag,
                root?["name"]?.ToString() ?? tag,
                root?["body"]?.ToString() ?? "",
                asset["browser_download_url"]!.ToString(),
                asset["name"]!.ToString(),
                asset["size"]?.GetValue<long>() ?? 0,
                digest != null && digest.StartsWith("sha256:", StringComparison.OrdinalIgnoreCase) ? digest[7..] : null,
                root?["html_url"]?.ToString() ?? $"https://github.com/{FeedRepo}/releases/latest");

            bool isNew = Available?.Version != release.Version;
            Available = release;
            Log.Info($"Update available: {release.Version} (current {CurrentVersion})");
            if (isNew) UpdateAvailable?.Invoke(release);
            return release;
        }
        catch (Exception ex)
        {
            LastError = "Update check failed: " + ex.Message;
            Log.Error("Update check", ex);
            return null;
        }
    }

    /// <summary>True when this copy was installed by the setup (not the portable zip).</summary>
    public static bool IsInstalled
    {
        get
        {
            try
            {
                using var key = Registry.CurrentUser.OpenSubKey($@"Software\Microsoft\Windows\CurrentVersion\Uninstall\{AppId}_is1");
                string? dir = key?.GetValue("InstallLocation") as string;
                return dir != null && AppContext.BaseDirectory.StartsWith(Path.GetFullPath(dir), StringComparison.OrdinalIgnoreCase);
            }
            catch { return false; }
        }
    }

    /// <summary>Downloads, verifies and starts the installer. Returns false if it could not.</summary>
    public async Task<bool> InstallAsync(Release r, IProgress<int>? progress = null)
    {
        try
        {
            string dir = Path.Combine(Path.GetTempPath(), "3DEarth-Update");
            Directory.CreateDirectory(dir);
            string file = Path.Combine(dir, r.InstallerName);

            using (var resp = await _http.GetAsync(r.InstallerUrl, HttpCompletionOption.ResponseHeadersRead))
            {
                resp.EnsureSuccessStatusCode();
                long total = resp.Content.Headers.ContentLength ?? r.Size;
                await using var src = await resp.Content.ReadAsStreamAsync();
                await using var dst = File.Create(file);
                var buffer = new byte[81920];
                long done = 0;
                int n;
                while ((n = await src.ReadAsync(buffer)) > 0)
                {
                    await dst.WriteAsync(buffer.AsMemory(0, n));
                    done += n;
                    if (total > 0) progress?.Report((int)(done * 100 / total));
                }
            }

            var info = new FileInfo(file);
            if (r.Size > 0 && info.Length != r.Size) throw new InvalidDataException("Downloaded file has the wrong size.");
            if (r.Sha256 != null)
            {
                await using var fs = File.OpenRead(file);
                string hash = Convert.ToHexString(await SHA256.HashDataAsync(fs));
                if (!hash.Equals(r.Sha256, StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException("Checksum mismatch.");
            }

            // Silent update; keep the user's start-with-Windows choice.
            string tasks = StartupRegistration.IsEnabled ? "autostart" : "!autostart";
            Process.Start(new ProcessStartInfo(file, $"/SILENT /SUPPRESSMSGBOXES /NORESTART /SP- /MERGETASKS=\"{tasks}\"") { UseShellExecute = true });
            Log.Info($"Started installer for {r.Version}");
            return true;
        }
        catch (Exception ex)
        {
            LastError = "Update failed: " + ex.Message;
            Log.Error("Installing update", ex);
            return false;
        }
    }

    private static Version Normalize(Version v) => new(v.Major, Math.Max(0, v.Minor), Math.Max(0, v.Build));

    public void Dispose()
    {
        _timer?.Dispose();
        _http.Dispose();
    }
}
