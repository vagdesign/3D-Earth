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

    public DataService(Func<AppSettings> settings)
    {
        _settings = settings;
        _http = new HttpClient { Timeout = TimeSpan.FromSeconds(90) };
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

    private async Task<bool> EnsureTexturesAsync(JsonObject manifest, bool force)
    {
        string quality = _settings().Quality;
        int earthWidth = quality == "high" ? 8192 : 4096;
        string wanted = $"v1-{earthWidth}";
        if (!force && manifest["texturesSet"]?.GetValue<string>() == wanted) return false;

        var sources = new[]
        {
            // Solar System Scope textures (CC BY 4.0), based on NASA imagery.
            new TextureSource("earth_day.jpg", earthWidth, false, [
                "https://www.solarsystemscope.com/textures/download/8k_earth_daymap.jpg",
            ]),
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
        {
            foreach (var url in src.Urls)
            {
                try
                {
                    var bytes = await DownloadImageAsync(url, minBytes: 50_000);
                    if (bytes == null) continue;
                    SaveImage(bytes, Path.Combine(Paths.Data, src.File), src.MaxWidth, src.Grayscale);
                    any = true;
                    Log.Info($"Texture {src.File} <- {url}");
                    break;
                }
                catch (Exception ex) { Log.Error($"Texture {src.File} from {url}", ex); }
            }
        }

        if (any)
        {
            manifest["texturesSet"] = wanted;
            manifest["textures"] = DateTime.UtcNow.ToString("o");
        }
        return any;
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
