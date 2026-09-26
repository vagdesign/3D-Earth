using System.Text.Json;
using System.Text.Json.Serialization;

namespace ThreeDEarth;

/// <summary>
/// User settings. Property names are serialised in camelCase and sent to the
/// web page as-is, so they must match web/js/settings.js.
/// </summary>
public sealed class AppSettings
{
    // --- scene (shared with the page) ---
    public string View { get; set; } = "moon";           // moon | home | sunrise
    public double HomeLat { get; set; } = 38.0;
    public double HomeLon { get; set; } = 23.7;
    public double EarthFill { get; set; } = 0.96;
    public double EarthPosition { get; set; } = 0.0;
    public double Fov { get; set; } = 40;
    public double SunsideBias { get; set; } = 30;
    public double MoonScale { get; set; } = 1;
    public bool Clouds { get; set; } = true;
    public double CloudOpacity { get; set; } = 1;
    public double CloudCover { get; set; } = 1;
    public double CloudDetail { get; set; } = 1;
    public bool CloudLoop { get; set; } = true;
    public bool Storms { get; set; } = true;
    public bool Labels { get; set; } = true;
    public bool Credits { get; set; } = true;
    public double Stars { get; set; } = 0.6;
    public double MilkyWay { get; set; } = 0.5;
    public double Exposure { get; set; } = 1.0;
    public double LandBrightness { get; set; } = 1.0;
    public double OceanReflection { get; set; } = 1.0;
    public double OceanRoughness { get; set; } = 0.35;
    public double Haze { get; set; } = 1.0;
    public string Motion { get; set; } = "live";         // live | spin | timelapse | daylapse
    public double SpinSeconds { get; set; } = 60;
    public double TimeSpeed { get; set; } = 60;
    public string CustomTime { get; set; } = "";         // ISO 8601 UTC, empty = now
    public string Quality { get; set; } = "medium";      // low | medium | high
    public int Fps { get; set; } = 30;
    public double RenderScale { get; set; } = 1;

    // --- host only ---
    public string Monitors { get; set; } = "all";        // all | primary
    public bool PauseWhenCovered { get; set; } = true;
    public bool PauseOnBattery { get; set; } = true;
    public int WeatherRefreshMinutes { get; set; } = 30;
    public string CustomCloudUrl { get; set; } = "";
    public bool FirstRunDone { get; set; }

    public static readonly JsonSerializerOptions Json = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        WriteIndented = true,
        NumberHandling = JsonNumberHandling.AllowReadingFromString,
    };

    public AppSettings Clone() => JsonSerializer.Deserialize<AppSettings>(JsonSerializer.Serialize(this, Json), Json)!;

    public static AppSettings Load()
    {
        try
        {
            if (File.Exists(Paths.SettingsFile))
            {
                var s = JsonSerializer.Deserialize<AppSettings>(File.ReadAllText(Paths.SettingsFile), Json);
                if (s != null) return s;
            }
        }
        catch (Exception ex) { Log.Error("Loading settings", ex); }

        var fresh = new AppSettings();
        fresh.GuessHomeFromTimeZone();
        return fresh;
    }

    public void Save()
    {
        try
        {
            var tmp = Paths.SettingsFile + ".tmp";
            File.WriteAllText(tmp, JsonSerializer.Serialize(this, Json));
            File.Move(tmp, Paths.SettingsFile, overwrite: true);
        }
        catch (Exception ex) { Log.Error("Saving settings", ex); }
    }

    /// <summary>A first guess of the user's longitude from the Windows time zone.</summary>
    public void GuessHomeFromTimeZone()
    {
        var offset = TimeZoneInfo.Local.BaseUtcOffset.TotalHours;
        HomeLon = Math.Round(Math.Clamp(offset * 15.0, -180, 180), 1);
        HomeLat = offset switch
        {
            >= 1 and <= 3 => 42,       // Europe / Middle East
            >= 4 and <= 6 => 28,       // South Asia
            >= 7 and <= 9.5 => 35,     // East Asia
            >= 10 => -30,              // Australia / NZ
            <= -3 and >= -3.5 => -20,  // South America
            _ => 38,
        };
    }
}
