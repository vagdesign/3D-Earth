using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Globalization;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace ThreeDEarth;

/// <summary>
/// Downloads live weather (global cloud map, active tropical cyclones) and, once,
/// higher-resolution Earth/Moon textures into %LOCALAPPDATA%\3D Earth\data.
/// The page reads data/manifest.json to know what changed.
/// </summary>
internal sealed class DataService : IDisposable
{
    private readonly HttpClient _http;
    private readonly SemaphoreSlim _gate = new(1, 1);
    private readonly Func<AppSettings> _settings;
    private System.Threading.Timer? _timer;

    public event Action? DataChanged;
    public DateTime? LastCloudUpdate { get; private set; }
    public int LastStormCount { get; private set; }
    public string LastError { get; private set; } = "";
    public int HistoryCount { get; private set; }
    public double HistoryHours { get; private set; }

    public DataService(Func<AppSettings> settings)
    {
        _settings = settings;
        _http = new HttpClient { Timeout = TimeSpan.FromMinutes(6) };
        _http.DefaultRequestHeaders.UserAgent.Add(new ProductInfoHeaderValue("3DEarth", "0.1"));
        _http.DefaultRequestHeaders.UserAgent.Add(new ProductInfoHeaderValue("(+https://github.com/vagdesign/3D-Earth)"));
    }

    public void Start()
    {
        Reschedule();
    }

    public void Reschedule()
    {
        int minutes = Math.Clamp(_settings().WeatherRefreshMinutes, 15, 24 * 60);
        _timer?.Dispose();
        _timer = new System.Threading.Timer(_ => _ = RefreshAsync(), null, TimeSpan.FromSeconds(3), TimeSpan.FromMinutes(minutes));
    }

    public async Task RefreshAsync(bool forceTextures = false)
    {
        if (!await _gate.WaitAsync(0)) return;
        try
        {
            var manifest = ReadManifest();
            bool changed = false;
            LastError = "";

            changed |= await EnsureTexturesAsync(manifest, forceTextures);
            changed |= await UpdateCloudsAsync(manifest);
            changed |= await UpdateStormsAsync(manifest);
            WriteHistory(manifest, ReadHistory(manifest));

            manifest["updated"] = DateTime.UtcNow.ToString("o");
            WriteManifest(manifest);
            if (changed) DataChanged?.Invoke();
        }
        catch (Exception ex)
        {
            LastError = ex.Message;
            Log.Error("Data refresh", ex);
        }
        finally { _gate.Release(); }
    }

    // ---------------------------------------------------------------- textures

    private sealed record TextureSource(string File, int MaxWidth, bool Grayscale, string[] Urls);

    // NASA Blue Marble Next Generation (topography + bathymetry), one map per month of 2004.
    private static readonly string[] BlueMarbleIds =
        ["73580", "73605", "73630", "73655", "73701", "73726", "73751", "73776", "73801", "73826", "73884", "73909"];

    /// <summary>Candidate URLs for the Earth surface map chosen in Settings (empty = built-in 4K).</summary>
    public static (string Id, string[] Urls) SurfaceSource(string choice, int month)
    {
        switch (choice)
        {
            case "bluemarble":
            {
                string mm = month.ToString("00", CultureInfo.InvariantCulture);
                string dir = $"https://eoimages.gsfc.nasa.gov/images/imagerecords/73000/{BlueMarbleIds[month - 1]}";
                return ($"bluemarble-{mm}", [
                    $"{dir}/world.topo.bathy.2004{mm}.3x21600x10800.jpg",
                    $"{dir}/world.topo.bathy.2004{mm}.3x5400x2700.jpg",
                ]);
            }
            case "naturalearth":
                return ("naturalearth", ["https://www.shadedrelief.com/natural3/ne3_data/8192/textures/2_no_clouds_8k.jpg"]);
            case "builtin":
                return ("builtin", []);
            default:
                return ("sss", ["https://www.solarsystemscope.com/textures/download/8k_earth_daymap.jpg"]);
        }
    }

    private async Task<bool> EnsureTexturesAsync(JsonObject manifest, bool force)
    {
        var s = _settings();
        int earthWidth = s.Quality == "high" ? 8192 : 4096;
        bool changed = false;

        // Night lights and the Moon (once per quality level).
        string wanted = $"v1-{earthWidth}";
        if (force || manifest["texturesSet"]?.GetValue<string>() != wanted)
        {
            var sources = new[]
            {
                // Solar System Scope textures (CC BY 4.0), based on NASA imagery.
                new TextureSource("earth_lights.jpg", earthWidth, true, [
                    "https://www.solarsystemscope.com/textures/download/8k_earth_nightmap.jpg",
                ]),
                new TextureSource("moon.jpg", 2048, false, [
                    "https://www.solarsystemscope.com/textures/download/2k_moon.jpg",
                    "https://svs.gsfc.nasa.gov/vis/a000000/a004700/a004720/lroc_color_poles_1k.jpg",
                ]),
            };
            bool any = false;
            foreach (var src in sources)
                any |= await DownloadFirstAsync(src.Urls, Path.Combine(Paths.Data, src.File), src.MaxWidth, src.Grayscale);
            if (any)
            {
                manifest["texturesSet"] = wanted;
                changed = true;
            }
        }

        // The Earth surface map chosen in Settings; each one is kept, so switching back is instant.
        var (id, urls) = SurfaceSource(s.SurfaceTexture, DateTime.UtcNow.Month);
        string surfaceKey = $"{id}-{earthWidth}";
        if (force || manifest["surfaceSet"]?.GetValue<string>() != surfaceKey)
        {
            string rel = "";
            if (urls.Length > 0)
            {
                rel = $"textures/{surfaceKey}.jpg";
                string full = Path.Combine(Paths.Data, "textures", $"{surfaceKey}.jpg");
                Directory.CreateDirectory(Path.GetDirectoryName(full)!);
                if (!File.Exists(full) && !await DownloadFirstAsync(urls, full, earthWidth, false))
                {
                    LastError = $"Could not download the \"{s.SurfaceTexture}\" surface map; keeping the current one.";
                    return changed;
                }
            }
            manifest["surfaceSet"] = surfaceKey;
            manifest["dayTexture"] = rel;
            changed = true;
            Log.Info($"Surface map: {(rel.Length > 0 ? rel : "built-in")}");
        }

        if (changed) manifest["textures"] = DateTime.UtcNow.ToString("o");
        return changed;
    }

    private async Task<bool> DownloadFirstAsync(string[] urls, string path, int maxWidth, bool grayscale)
    {
        foreach (var url in urls)
        {
            try
            {
                var bytes = await DownloadImageAsync(url, minBytes: 50_000);
                if (bytes == null) continue;
                SaveImage(bytes, path, maxWidth, grayscale);
                Log.Info($"Texture {Path.GetFileName(path)} <- {url} ({bytes.Length / 1024} KB)");
                return true;
            }
            catch (Exception ex) { Log.Error($"Texture {Path.GetFileName(path)} from {url}", ex); }
        }
        return false;
    }

    // ---------------------------------------------------------------- clouds

    private IEnumerable<string> CloudUrls()
    {
        var s = _settings();
        if (!string.IsNullOrWhiteSpace(s.CustomCloudUrl)) yield return s.CustomCloudUrl.Trim();
        string size = s.Quality switch { "high" => "8192x4096", "low" => "2048x1024", _ => "4096x2048" };
        // Matt Eason's live cloud maps: global composite of geostationary satellite
        // imagery (EUMETSAT / NOAA / JMA), refreshed several times a day.
        yield return $"https://clouds.matteason.co.uk/images/{size}/clouds.jpg";
        if (size != "4096x2048") yield return "https://clouds.matteason.co.uk/images/4096x2048/clouds.jpg";
    }

    private async Task<bool> UpdateCloudsAsync(JsonObject manifest)
    {
        foreach (var url in CloudUrls())
        {
            try
            {
                var bytes = await DownloadImageAsync(url, minBytes: 30_000);
                if (bytes == null) continue;
                string hash = Convert.ToHexString(SHA256.HashData(bytes))[..16];
                if (manifest["cloudsHash"]?.GetValue<string>() == hash && File.Exists(Path.Combine(Paths.Data, "clouds.jpg")))
                {
                    LastCloudUpdate ??= DateTime.Now;
                    return false;
                }
                // Re-encode as a single-channel-friendly JPEG capped at 8K.
                SaveImage(bytes, Path.Combine(Paths.Data, "clouds.jpg"), 8192, grayscale: true);
                manifest["cloudsHash"] = hash;
                manifest["clouds"] = DateTime.UtcNow.ToString("o");
                manifest["cloudsFile"] = "clouds.jpg";
                manifest["cloudsSource"] = url;
                AddToHistory(bytes, manifest);
                LastCloudUpdate = DateTime.Now;
                Log.Info("Clouds updated from " + url);
                return true;
            }
            catch (Exception ex)
            {
                LastError = "Clouds: " + ex.Message;
                Log.Error("Clouds from " + url, ex);
            }
        }
        return false;
    }

    // ---------------------------------------------------------------- 24 h history

    private static readonly TimeSpan HistoryWindow = TimeSpan.FromHours(26);

    /// <summary>
    /// Keeps every new cloud map for ~24 h (data/history) so time-lapse modes can
    /// replay the real last day of weather in a loop.
    /// </summary>
    private void AddToHistory(byte[] bytes, JsonObject manifest)
    {
        try
        {
            string dir = Path.Combine(Paths.Data, "history");
            Directory.CreateDirectory(dir);
            var now = DateTime.UtcNow;
            string name = $"clouds-{now:yyyyMMdd-HHmm}.jpg";
            SaveImage(bytes, Path.Combine(dir, name), 4096, grayscale: true);

            var entries = ReadHistory(manifest);
            entries.RemoveAll(e => e.File == "history/" + name);
            entries.Add(("history/" + name, now));
            WriteHistory(manifest, entries);
        }
        catch (Exception ex) { Log.Error("Cloud history", ex); }
    }

    private static List<(string File, DateTime T)> ReadHistory(JsonObject manifest)
    {
        var list = new List<(string, DateTime)>();
        if (manifest["history"] is JsonArray arr)
        {
            foreach (var n in arr)
            {
                string? file = n?["file"]?.ToString();
                if (file != null && DateTime.TryParse(n?["t"]?.ToString(), CultureInfo.InvariantCulture,
                        DateTimeStyles.AdjustToUniversal | DateTimeStyles.AssumeUniversal, out var t))
                    list.Add((file, t));
            }
        }
        return list;
    }

    private void WriteHistory(JsonObject manifest, List<(string File, DateTime T)> entries)
    {
        string dir = Path.Combine(Paths.Data, "history");
        Directory.CreateDirectory(dir);
        var cutoff = DateTime.UtcNow - HistoryWindow;
        var keep = entries
            .Where(e => e.T >= cutoff && File.Exists(Path.Combine(Paths.Data, e.File)))
            .OrderBy(e => e.T)
            .ToList();

        // Delete anything no longer referenced.
        var keepNames = new HashSet<string>(keep.Select(e => Path.GetFileName(e.File)), StringComparer.OrdinalIgnoreCase);
        foreach (var f in Directory.GetFiles(dir, "clouds-*.jpg"))
            if (!keepNames.Contains(Path.GetFileName(f))) { try { File.Delete(f); } catch { /* in use; next time */ } }

        var arr = new JsonArray();
        foreach (var e in keep)
            arr.Add(new JsonObject { ["t"] = e.T.ToString("yyyy-MM-ddTHH:mm:ssZ", CultureInfo.InvariantCulture), ["file"] = e.File });
        manifest["history"] = arr;
        UpdateHistoryStats(keep);
    }

    private void UpdateHistoryStats(List<(string File, DateTime T)> keep)
    {
        HistoryCount = keep.Count;
        HistoryHours = keep.Count >= 2 ? (keep[^1].T - keep[0].T).TotalHours : 0;
    }

    // ---------------------------------------------------------------- storms

    private sealed record Storm(string Name, string Kind, string Category, double Lat, double Lon, double WindKt, string Source);

    private async Task<bool> UpdateStormsAsync(JsonObject manifest)
    {
        var storms = new List<Storm>();
        await AddNhcAsync(storms);
        await AddGdacsAsync(storms);

        var json = JsonSerializer.Serialize(new
        {
            updated = DateTime.UtcNow.ToString("o"),
            storms = storms.Select(s => new { name = s.Name, kind = s.Kind, category = s.Category, lat = s.Lat, lon = s.Lon, windKt = s.WindKt, source = s.Source }),
        }, AppSettings.Json);

        string file = Path.Combine(Paths.Data, "storms.json");
        string old = File.Exists(file) ? File.ReadAllText(file) : "";
        LastStormCount = storms.Count;
        // Ignore the timestamp when comparing.
        if (StripUpdated(old) == StripUpdated(json)) return false;
        WriteAtomic(file, System.Text.Encoding.UTF8.GetBytes(json));
        manifest["storms"] = DateTime.UtcNow.ToString("o");
        return true;
    }

    private static string StripUpdated(string json)
    {
        int i = json.IndexOf("\"storms\"", StringComparison.Ordinal);
        return i < 0 ? json : json[i..];
    }

    // US National Hurricane Center: Atlantic, East and Central Pacific.
    private async Task AddNhcAsync(List<Storm> storms)
    {
        try
        {
            var text = await _http.GetStringAsync("https://www.nhc.noaa.gov/CurrentStorms.json");
            var root = JsonNode.Parse(text);
            if (root?["activeStorms"] is not JsonArray arr) return;
            foreach (var n in arr)
            {
                if (n == null) continue;
                string name = n["name"]?.ToString() ?? "";
                double lat = Num(n["latitudeNumeric"]), lon = Num(n["longitudeNumeric"]);
                double wind = Num(n["intensity"]);
                string cls = n["classification"]?.ToString() ?? "";
                if (double.IsNaN(lat) || double.IsNaN(lon)) continue;
                storms.Add(Classify(name, lat, lon, double.IsNaN(wind) ? 0 : wind, "NHC", cls));
            }
        }
        catch (Exception ex) { Log.Error("NHC storms", ex); }
    }

    // GDACS (EU JRC / UN OCHA): tropical cyclones worldwide.
    private async Task AddGdacsAsync(List<Storm> storms)
    {
        try
        {
            string from = DateTime.UtcNow.AddDays(-4).ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
            string to = DateTime.UtcNow.AddDays(1).ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
            string url = $"https://www.gdacs.org/gdacsapi/api/events/geteventlist/SEARCH?eventlist=TC&fromdate={from}&todate={to}&alertlevel=green;orange;red";
            var text = await _http.GetStringAsync(url);
            var root = JsonNode.Parse(text);
            if (root?["features"] is not JsonArray arr) return;
            foreach (var f in arr)
            {
                var p = f?["properties"];
                if (p == null) continue;
                string current = p["iscurrent"]?.ToString() ?? "true";
                if (!current.Equals("true", StringComparison.OrdinalIgnoreCase)) continue;

                string name = p["eventname"]?.ToString() ?? p["name"]?.ToString() ?? "";
                int dash = name.LastIndexOf('-');
                if (dash > 0 && int.TryParse(name[(dash + 1)..], out _)) name = name[..dash];   // "MILTON-24" -> "MILTON"
                name = name.Replace("Tropical Cyclone ", "", StringComparison.OrdinalIgnoreCase).Trim();
                if (storms.Any(s => s.Name.Equals(name, StringComparison.OrdinalIgnoreCase))) continue;

                var coords = f?["geometry"]?["coordinates"] as JsonArray;
                if (coords == null || coords.Count < 2) continue;
                double lon = Num(coords[0]), lat = Num(coords[1]);
                if (double.IsNaN(lat) || double.IsNaN(lon)) continue;

                double wind = 0;
                var sev = p["severitydata"];
                if (sev != null)
                {
                    double v = Num(sev["severity"]);
                    string unit = sev["severityunit"]?.ToString() ?? "km/h";
                    if (!double.IsNaN(v)) wind = unit.Contains("km", StringComparison.OrdinalIgnoreCase) ? v / 1.852 : v;
                }
                storms.Add(Classify(ToTitle(name), lat, lon, wind, "GDACS", ""));
            }
        }
        catch (Exception ex) { Log.Error("GDACS storms", ex); }
    }

    private static Storm Classify(string name, double lat, double lon, double windKt, string source, string nhcClass)
    {
        string kind;
        if (nhcClass is "TD") kind = "Tropical Depression";
        else if (nhcClass is "STD" or "STS") kind = "Subtropical Storm";
        else if (nhcClass is "PTC") kind = "Potential Tropical Cyclone";
        else if (nhcClass is "PC") kind = "Post-tropical Cyclone";
        else if (windKt >= 64)
        {
            bool nwPacific = lat > 0 && lon >= 100 && lon <= 180;
            bool hurricaneBasin = lat > 0 && lon < -20 && lon > -180;
            kind = nwPacific ? "Typhoon" : hurricaneBasin ? "Hurricane" : "Cyclone";
        }
        else if (windKt >= 34) kind = "Tropical Storm";
        else kind = windKt > 0 ? "Tropical Depression" : "Storm";

        string category = windKt switch
        {
            >= 137 => "Cat 5",
            >= 113 => "Cat 4",
            >= 96 => "Cat 3",
            >= 83 => "Cat 2",
            >= 64 => "Cat 1",
            _ => "",
        };
        return new Storm(ToTitle(name), kind, category, lat, lon, Math.Round(windKt), source);
    }

    private static string ToTitle(string s) =>
        string.IsNullOrEmpty(s) ? s : CultureInfo.InvariantCulture.TextInfo.ToTitleCase(s.ToLowerInvariant());

    private static double Num(JsonNode? n)
    {
        if (n == null) return double.NaN;
        try
        {
            if (n is JsonValue v)
            {
                if (v.TryGetValue(out double d)) return d;
                if (v.TryGetValue(out string? str) &&
                    double.TryParse(str, NumberStyles.Float, CultureInfo.InvariantCulture, out var parsed)) return parsed;
            }
        }
        catch { /* not a number */ }
        return double.NaN;
    }

    // ---------------------------------------------------------------- helpers

    private async Task<byte[]?> DownloadImageAsync(string url, int minBytes)
    {
        using var resp = await _http.GetAsync(url, HttpCompletionOption.ResponseHeadersRead);
        if (!resp.IsSuccessStatusCode)
        {
            Log.Info($"{url} -> HTTP {(int)resp.StatusCode}");
            return null;
        }
        var type = resp.Content.Headers.ContentType?.MediaType ?? "";
        var bytes = await resp.Content.ReadAsByteArrayAsync();
        if (bytes.Length < minBytes || (type.Length > 0 && !type.StartsWith("image/") && type != "application/octet-stream"))
        {
            Log.Info($"{url} -> unexpected content ({type}, {bytes.Length} bytes)");
            return null;
        }
        return bytes;
    }

    /// <summary>Decodes, optionally downsizes / converts to grayscale, and saves as JPEG.</summary>
    private static void SaveImage(byte[] bytes, string path, int maxWidth, bool grayscale)
    {
        try
        {
            SaveImageWic(bytes, path, maxWidth, grayscale);
        }
        catch (Exception ex)
        {
            Log.Error("WIC decode failed; falling back to GDI+", ex);
            SaveImageGdi(bytes, path, maxWidth, grayscale);
        }
    }

    // Windows Imaging Component: JPEGs are scaled while decoding, so a 21600 px
    // NASA map never needs a full-size bitmap in memory.
    private static void SaveImageWic(byte[] bytes, string path, int maxWidth, bool grayscale)
    {
        using var probe = new MemoryStream(bytes);
        var decoder = System.Windows.Media.Imaging.BitmapDecoder.Create(probe,
            System.Windows.Media.Imaging.BitmapCreateOptions.DelayCreation | System.Windows.Media.Imaging.BitmapCreateOptions.IgnoreColorProfile,
            System.Windows.Media.Imaging.BitmapCacheOption.None);
        int width = decoder.Frames[0].PixelWidth;

        var bi = new System.Windows.Media.Imaging.BitmapImage();
        bi.BeginInit();
        bi.CacheOption = System.Windows.Media.Imaging.BitmapCacheOption.OnLoad;
        bi.CreateOptions = System.Windows.Media.Imaging.BitmapCreateOptions.IgnoreColorProfile;
        bi.StreamSource = new MemoryStream(bytes);
        if (width > maxWidth) bi.DecodePixelWidth = maxWidth;
        bi.EndInit();
        bi.Freeze();

        System.Windows.Media.Imaging.BitmapSource src = bi;
        if (grayscale)
        {
            var gray = new System.Windows.Media.Imaging.FormatConvertedBitmap(bi, System.Windows.Media.PixelFormats.Gray8, null, 0);
            gray.Freeze();
            src = gray;
        }
        var enc = new System.Windows.Media.Imaging.JpegBitmapEncoder { QualityLevel = 92 };
        enc.Frames.Add(System.Windows.Media.Imaging.BitmapFrame.Create(src));
        using var ms = new MemoryStream();
        enc.Save(ms);
        WriteAtomic(path, ms.ToArray());
    }

    private static void SaveImageGdi(byte[] bytes, string path, int maxWidth, bool grayscale)
    {
        using var input = new MemoryStream(bytes);
        using var src = Image.FromStream(input, useEmbeddedColorManagement: false, validateImageData: true);
        int w = Math.Min(maxWidth, src.Width);
        int h = (int)Math.Round((double)src.Height * w / src.Width);
        using var dst = new Bitmap(w, h, PixelFormat.Format24bppRgb);
        using (var g = Graphics.FromImage(dst))
        {
            g.InterpolationMode = InterpolationMode.HighQualityBicubic;
            g.PixelOffsetMode = PixelOffsetMode.HighQuality;
            g.CompositingMode = CompositingMode.SourceCopy;
            if (grayscale)
            {
                var cm = new ColorMatrix(new float[][]
                {
                    new float[] { 0.299f, 0.299f, 0.299f, 0f, 0f },
                    new float[] { 0.587f, 0.587f, 0.587f, 0f, 0f },
                    new float[] { 0.114f, 0.114f, 0.114f, 0f, 0f },
                    new float[] { 0f, 0f, 0f, 1f, 0f },
                    new float[] { 0f, 0f, 0f, 0f, 1f },
                });
                using var ia = new ImageAttributes();
                ia.SetColorMatrix(cm);
                ia.SetWrapMode(WrapMode.TileFlipXY);
                g.DrawImage(src, new Rectangle(0, 0, w, h), 0, 0, src.Width, src.Height, GraphicsUnit.Pixel, ia);
            }
            else
            {
                using var ia = new ImageAttributes();
                ia.SetWrapMode(WrapMode.TileFlipXY);
                g.DrawImage(src, new Rectangle(0, 0, w, h), 0, 0, src.Width, src.Height, GraphicsUnit.Pixel, ia);
            }
        }

        var jpeg = ImageCodecInfo.GetImageEncoders().First(c => c.FormatID == ImageFormat.Jpeg.Guid);
        using var ep = new EncoderParameters(1);
        ep.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, 92L);
        using var ms = new MemoryStream();
        dst.Save(ms, jpeg, ep);
        WriteAtomic(path, ms.ToArray());
    }

    private static void WriteAtomic(string path, byte[] bytes)
    {
        string tmp = path + ".part";
        File.WriteAllBytes(tmp, bytes);
        File.Move(tmp, path, overwrite: true);
    }

    private static string ManifestPath => Path.Combine(Paths.Data, "manifest.json");

    private static JsonObject ReadManifest()
    {
        try
        {
            if (File.Exists(ManifestPath) && JsonNode.Parse(File.ReadAllText(ManifestPath)) is JsonObject o) return o;
        }
        catch { /* rebuilt below */ }
        return new JsonObject();
    }

    private static void WriteManifest(JsonObject m) =>
        WriteAtomic(ManifestPath, System.Text.Encoding.UTF8.GetBytes(m.ToJsonString(AppSettings.Json)));

    public void Dispose()
    {
        _timer?.Dispose();
        _http.Dispose();
    }
}
