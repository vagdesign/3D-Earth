using System.Globalization;
using System.Text.Json.Nodes;
using WicImaging = System.Windows.Media.Imaging;
using WicMedia = System.Windows.Media;

namespace ThreeDEarth;

/// <summary>One cloud map source from sources.json, tried in order.</summary>
internal sealed record CloudSource(string Id, string Name, string Type, string Url, string[] Sizes, string? Status,
    double MaxAgeHours, double TimeoutSeconds, JsonObject Raw);

/// <summary>
/// The data-source list every installation reads (sources/sources.json in the repo,
/// published on the data site). Editing it switches sources for all installations
/// without an app release. Order: the locations named by the last copy we got
/// (manifestUrls, so the file can move), the built-in locations, the cached copy,
/// the copy shipped with the app.
/// </summary>
internal static class SourceList
{
    private static readonly string[] BuiltInUrls =
    {
        "https://vagdesign.github.io/3D-Earth/sources.json",
        "https://raw.githubusercontent.com/vagdesign/3D-Earth/main/sources/sources.json",
    };

    public static string Origin { get; private set; } = "";

    private static string CachePath => Path.Combine(Paths.Data, "sources.json");
    private static string BundledPath => Path.Combine(AppContext.BaseDirectory, "sources.json");

    public static async Task<JsonObject> LoadAsync(HttpClient http)
    {
        var cached = Parse(Read(CachePath));
        var urls = new List<string>();
        if (cached?["manifestUrls"] is JsonArray listed)
            urls.AddRange(listed.Select(n => n?.ToString()).OfType<string>().Where(u => u.StartsWith("https://")));
        urls.AddRange(BuiltInUrls);
        foreach (var url in urls.Distinct())
        {
            try
            {
                using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(8));
                string text = await http.GetStringAsync(url, cts.Token);
                var obj = Parse(text);
                if (obj == null) { Log.Info($"Sources {url}: not a valid source list"); continue; }
                try { File.WriteAllText(CachePath, text); } catch { /* keep going */ }
                Origin = url;
                return obj;
            }
            catch (Exception ex) { Log.Info($"Sources {url}: {ex.Message}"); }
        }
        if (cached != null) { Origin = "cached copy"; return cached; }
        Origin = "built-in copy";
        return Parse(Read(BundledPath)) ?? new JsonObject();
    }

    public static List<CloudSource> Clouds(JsonObject list)
    {
        var result = new List<CloudSource>();
        if (list["clouds"] is not JsonArray arr) return result;
        foreach (var n in arr)
        {
            if (n is not JsonObject o) continue;
            string? id = o["id"]?.ToString(), url = o["url"]?.ToString();
            if (string.IsNullOrEmpty(id) || url == null || !url.StartsWith("https://")) continue;
            string type = o["type"]?.ToString() ?? "image";
            if (type != "image" && type != "wms-ir") continue;          // unknown to this version: skip
            var sizes = (o["sizes"] as JsonArray)?.Select(s => s?.ToString()).OfType<string>().ToArray() ?? Array.Empty<string>();
            result.Add(new CloudSource(id, o["name"]?.ToString() ?? id, type, url, sizes, o["status"]?.ToString(),
                Num(o, "maxAgeHours", 9), Math.Clamp(Num(o, "timeoutSeconds", 8), 2, 120), o));
        }
        return result;
    }

    public static double Num(JsonObject o, string key, double fallback)
    {
        try { return o[key]?.GetValue<double>() ?? fallback; } catch { return fallback; }
    }

    private static string? Read(string path) { try { return File.Exists(path) ? File.ReadAllText(path) : null; } catch { return null; } }

    private static JsonObject? Parse(string? text)
    {
        if (string.IsNullOrWhiteSpace(text)) return null;
        try
        {
            return JsonNode.Parse(text) is JsonObject o && o["schema"]?.GetValue<int>() == 1 && o["clouds"] is JsonArray ? o : null;
        }
        catch { return null; }
    }

    /// <summary>The wanted size if offered, else the largest smaller one, else the smallest.</summary>
    public static string PickSize(string[] sizes, string wanted)
    {
        if (sizes.Length == 0 || sizes.Contains(wanted)) return wanted;
        static int Width(string s) => int.TryParse(s.Split('x')[0], out var w) ? w : 0;
        int want = Width(wanted);
        return sizes.Where(s => Width(s) <= want).OrderByDescending(Width).FirstOrDefault()
               ?? sizes.OrderBy(Width).First();
    }

    /// <summary>
    /// Last-resort source: EUMETSAT's infrared world cloud map, fetched as two
    /// hemispheres, joined and turned into a greyscale cloud map here.
    /// </summary>
    public static async Task<byte[]?> BuildWmsIrAsync(CloudSource src, string size, Func<string, double, Task<byte[]?>> download)
    {
        int h = int.Parse(size.Split('x')[1], CultureInfo.InvariantCulture);
        string[] bboxes = { "-90,-180,90,0", "-90,0,90,180" };
        var gray = new byte[2 * h * h];
        for (int k = 0; k < 2; k++)
        {
            string url = src.Url.Replace("{bbox}", bboxes[k]).Replace("{half}", h.ToString(CultureInfo.InvariantCulture));
            var png = await download(url, src.TimeoutSeconds);
            if (png == null) return null;
            var half = DecodeGray(png, h);
            for (int y = 0; y < h; y++) Buffer.BlockCopy(half, y * h, gray, y * 2 * h + k * h, h);
        }

        // Same curve as the full cloud service, without the dust/visible layers.
        var levels = src.Raw["levels"] as JsonArray;
        double lo = levels?.Count == 2 ? levels[0]!.GetValue<double>() : 72, hi = levels?.Count == 2 ? levels[1]!.GetValue<double>() : 178;
        double g1 = Num(src.Raw, "gamma", 1.46), gain = Num(src.Raw, "gain", 0.77), g2 = Num(src.Raw, "gamma2", 2.0);
        var lut = new byte[256];
        for (int v = 0; v < 256; v++)
        {
            if (v >= 250) { lut[v] = 0; continue; }              // no data (antimeridian, poles)
            double t = Math.Clamp((v - lo) / (hi - lo), 0, 1);
            double o = Math.Pow(Math.Pow(t, 1 / g1) * gain, 1 / g2);
            lut[v] = (byte)Math.Round(Math.Clamp(o, 0, 1) * 255);
        }
        int lit = 0;
        for (int i = 0; i < gray.Length; i++) { gray[i] = lut[gray[i]]; if (gray[i] > 40) lit++; }
        if (lit < gray.Length / 200) throw new InvalidDataException("EUMETSAT infrared map is blank");

        var bmp = WicImaging.BitmapSource.Create(2 * h, h, 96, 96, WicMedia.PixelFormats.Gray8, null, gray, 2 * h);
        var enc = new WicImaging.JpegBitmapEncoder { QualityLevel = 88 };
        enc.Frames.Add(WicImaging.BitmapFrame.Create(bmp));
        using var ms = new MemoryStream();
        enc.Save(ms);
        return ms.ToArray();
    }

    private static byte[] DecodeGray(byte[] png, int size)
    {
        var decoder = WicImaging.BitmapDecoder.Create(new MemoryStream(png),
            WicImaging.BitmapCreateOptions.IgnoreColorProfile, WicImaging.BitmapCacheOption.OnLoad);
        WicImaging.BitmapSource frame = decoder.Frames[0];
        if (frame.PixelWidth != size || frame.PixelHeight != size)
            frame = new WicImaging.TransformedBitmap(frame,
                new WicMedia.ScaleTransform((double)size / frame.PixelWidth, (double)size / frame.PixelHeight));
        var gray = new WicImaging.FormatConvertedBitmap(frame, WicMedia.PixelFormats.Gray8, null, 0);
        var buf = new byte[size * size];
        gray.CopyPixels(buf, size, 0);
        return buf;
    }
}
