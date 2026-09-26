namespace ThreeDEarth;

/// <summary>
/// Ready-made combinations of settings. "Showcase" is also what a fresh install
/// starts with (unless a defaults.json next to the executable says otherwise).
/// Presets never touch the home location, monitors or start-with-Windows.
/// </summary>
internal static class Presets
{
    public sealed record Preset(string Name, Action<AppSettings> Apply);

    public static readonly Preset[] All =
    [
        new("Showcase: day & night time-lapse above my location", s =>
        {
            s.View = "home";
            s.Motion = "daylapse";
            s.TimeSpeed = 1200;
            s.SpinSeconds = 120;
            s.CloudLoop = true;
            s.Quality = "high";
            s.Antialias = 8;
            s.Fps = 60;
            s.Clouds = true;
            s.CloudDetail = 1;
            s.CloudCover = 1;
            s.Labels = true;
            s.Storms = true;
            s.Credits = true;
        }),
        new("Real time: the Moon beside the Earth", s =>
        {
            s.View = "moon";
            s.Motion = "live";
            s.Quality = "medium";
            s.Antialias = 4;
            s.Fps = 30;
            s.Clouds = true;
            s.Labels = true;
            s.Storms = true;
        }),
        new("Spin 360° around my location", s =>
        {
            s.View = "home";
            s.Motion = "spin";
            s.SpinSeconds = 120;
            s.Quality = "high";
            s.Antialias = 8;
            s.Fps = 60;
        }),
        new("Sunrise behind the Earth", s =>
        {
            s.View = "sunrise";
            s.Motion = "live";
            s.Labels = false;
            s.Quality = "high";
            s.Antialias = 8;
        }),
        new("Power saver (laptops, integrated graphics)", s =>
        {
            s.Quality = "low";
            s.Antialias = 0;
            s.Fps = 15;
            s.Motion = "live";
            s.PauseOnBattery = true;
            s.PauseWhenCovered = true;
        }),
    ];

    /// <summary>Settings for a brand-new install.</summary>
    public static AppSettings FirstRun()
    {
        var s = new AppSettings();
        All[0].Apply(s);
        // An installer can ship its own starting point.
        try
        {
            string file = Path.Combine(AppContext.BaseDirectory, "defaults.json");
            if (File.Exists(file))
            {
                var d = System.Text.Json.JsonSerializer.Deserialize<AppSettings>(File.ReadAllText(file), AppSettings.Json);
                if (d != null) s = d;
            }
        }
        catch (Exception ex) { Log.Error("Reading defaults.json", ex); }
        s.GuessHomeFromTimeZone();
        s.FirstRunDone = false;
        return s;
    }
}
